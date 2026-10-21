# Phase 2 — deterministic normalizer integration

**Branch:** `arena/ba533186-tr-calender`
**Implementation commit:** `3462705` (`feat: integrate the deterministic normalizer into submissions`)
**Base:** `0337d67` (Phase 1 corrective pass)
**Date:** 2026-10-20
**Scope:** the smallest safe end-to-end integration of the existing `rules-v1`
normalizer into the anonymous submission → administrator review → publication
flow. No OCR, no model provider, no new dependency, no database changes
applied, no deployment, no merge.

---

## 1. Outcome

| Requirement | Status |
| --- | --- |
| Anonymous submission still accepted, receipt unchanged | Done (response schema untouched) |
| Normalizer runs after the submission transaction commits, awaited | Done (`submissions.ts:302`) |
| Draft validated and persisted separately from raw input | Done (five additive columns, `submissionNormalization.ts`) |
| Admin sees status, version, draft, flags, questions, changed fields | Done (`App.tsx`, `NormalizationPanel`) |
| Admin edits and explicitly approves or rejects | Done (form prefilled from the draft, existing approve/reject unchanged) |
| Normalization can never publish | Done (normalization only writes `community_submissions`) |
| Approval endpoint rejects `endAt < startAt` | Done (`submissions.ts:366`) with a route-level regression test |
| Public submission form and public event responses unchanged | Done (no public schema or route touched) |

**Deployment prerequisite:** the additive columns in §3 must be applied with
`pnpm --filter @workspace/db run push` (or an equivalent reviewed migration)
**before** this code is deployed. Until then the admin list query would fail
(it selects all columns) and normalization results could not be stored. The
public submission endpoint would still return 201, because a failed
normalization write is caught. No database was touched in this task.

---

## 2. Data flow

```
POST /api/submissions                       (unchanged request/response contract)
  ├─ existing validation, honeypot, duplicate check, interval check
  ├─ transaction: insert community_submissions + claim uploads   (unchanged)
  ├─ runPostCommitNormalization(submission, req.log)            (new, awaited)
  │    ├─ toNormalizerInput(row)         title/category/dates/location/details/
  │    │                                 organizer/sourceUrl/duplicatePotential
  │    │                                 (followUpEmail is not part of the input)
  │    ├─ runNormalization(rules-v1, { referenceTime: createdAt })
  │    ├─ validateDraft(...)             draft exists only if the contract passes
  │    └─ UPDATE community_submissions   SET normalized_draft, normalization_status,
  │                                      normalizer_version,
  │                                      normalization_reference_time,
  │                                      normalization_error_code
  └─ 201 receipt                         unchanged

GET /api/admin/submissions                   (requireAdmin, unchanged)
  └─ submissionResponse(row)
       ├─ explicit field mapping             raw columns, never `...row`
       └─ normalization                     readStoredNormalization(row)
                                             re-validates the stored JSON

POST /api/admin/submissions/:id/approve      (requireAdmin, unchanged gate)
  ├─ Zod body validation
  ├─ endsBeforeStart(...) → 400              new: no insert, no status change
  └─ transaction: insert event (published) + mark submission approved
```

Nothing in the normalization path imports or writes `community_events`; the only
path to `status: "published"` is still the approval route.

---

## 3. Database change (not applied)

`lib/db/src/schema/community.ts:73-82`, `submissionsTable` only, all additive:

| Column | Type | Null/Default | Purpose |
| --- | --- | --- | --- |
| `normalized_draft` | `jsonb` | nullable | the draft, **only** when `validateDraft` accepted it |
| `normalization_status` | `text` | `not null default 'not_run'` | one of the six stored statuses |
| `normalizer_version` | `text` | nullable | e.g. `rules-v1` |
| `normalization_reference_time` | `timestamptz` | nullable | the submission timestamp given to the normalizer |
| `normalization_error_code` | `text` | nullable | one of the four contract error codes |

Notes:

- Existing rows read as `not_run` with a null draft; no backfill is required.
- The draft is stored as one validated value. Review flags, changed fields and
  unresolved questions live inside it, so no separate flag column duplicates
  them.
- `follow_up_email` is untouched and is not copied into the draft.
- No migration system was added. `drizzle-kit push` was **not** run and no
  database was contacted.

---

## 4. API contract

`lib/api-spec/openapi.yaml` was edited first, then
`pnpm --filter @workspace/api-spec run codegen` regenerated the Zod schemas and
the React client. Re-running codegen on the committed tree produces no diff.

New schemas (`openapi.yaml:742-862`):

| Schema | Notes |
| --- | --- |
| `NormalizationStatus` | `not_run`, `normalized`, `needs_review`, `invalid_input`, `failed`, `cancelled` |
| `NormalizationErrorCode` | the four contract codes |
| `ReviewFlagCode` | the 21 append-only codes |
| `ReviewFlag` | `{code, message}` |
| `DraftField` | the 14 field names reported in `changedFields` |
| `NormalizedEventDraft` | every draft field, with the same length limits as `Event` |
| `SubmissionNormalization` | `{status, version, referenceTime, errorCode, draft}` |

`Submission` gains the required `normalization` property
(`openapi.yaml:863`). It is only reachable through the two admin endpoints.

Generated changes: `lib/api-zod/src/generated/api.ts`,
`lib/api-zod/src/generated/types/*` (seven new files plus `submission.ts` and
`index.ts`), `lib/api-client-react/src/generated/api.schemas.ts`.

**Unchanged:** `SubmissionInput`, `SubmissionReceipt`, `Event`, `EventInput`,
every public route and every public response. Normalization data is never
exposed outside the admin submission endpoints.

---

## 5. Server implementation

### `src/lib/submissionNormalization.ts` (new)

| Export | Responsibility |
| --- | --- |
| `toNormalizerInput` | row → normalizer input; `followUpEmail` is structurally absent; dates become ISO strings |
| `normalizeSubmission` | runs the provider with `referenceTime = createdAt`; maps the result to column values; never reads the clock; never throws |
| `persistNormalization` | runs the supplied write; returns `false` instead of throwing |
| `normalizeAndStore` | normalize + persist in one non-throwing step |
| `readStoredNormalization` | re-validates the stored JSON and returns the admin view |

Rules encoded here:

- a draft is persisted only when the normalizer's `validateDraft` accepted it;
- `readStoredNormalization` re-validates on every read, so a corrupt or outdated
  stored draft is reported as `failed` / `invalid_provider_output` with
  `draft: null` rather than being served;
- status is always made consistent with the draft that is returned (a draft
  with flags is reported as `needs_review`, never `normalized`);
- an unknown stored status is treated as `not_run`;
- `normalized` keeps its Phase 1 meaning: a valid draft with no review flags,
  not verification, approval or permission to publish.

### `src/routes/submissions.ts`

- `submissionResponse` (line 67) now maps fields explicitly and adds
  `normalization: readStoredNormalization(row)`. Raw columns (`normalizedDraft`,
  `normalizationStatus`, `updatedAt`, …) cannot reach the response.
- `runPostCommitNormalization` (line 110) is the exact step the route calls after
  the transaction (line 302). It never throws and logs only a submission id and
  a status (no error object, no submitted text, no upload tokens).
- The receipt returned to the submitter is unchanged in shape, status and
  wording.

### Failure handling

| Condition | Submission | Stored status | Admin sees |
| --- | --- | --- | --- |
| No text at all (flyer only) | 201 | `needs_review` with a null-valued draft | draft with `missing_title`, `missing_date`, `missing_location`, `category_uncertain`, `cost_unclear` |
| Provider throws | 201 | `failed` + `internal_error` | failed, no draft |
| Provider output invalid | 201 | `failed` + `invalid_provider_output` | failed, no draft |
| Result write fails (e.g. column missing, DB error) | 201 | stays `not_run` | "Normalization did not run" |
| Invalid reference time | 201 | `failed` + `invalid_input` | failed, no draft |

`normalized` is never displayed as verified or approved; the panel says
"This is not verification: a person must still check it."

---

## 6. Administrator interface

`artifacts/tumbler-ridge-calendar/src/App.tsx`:

- `NormalizationPanel` (line 383) shows, for every submission: status, version,
  reference time, error code; the suggested title/category/dates/all-day/
  location/organizer/contact/cost/registration/source/summary/tags; every review
  flag with its canonical message; the canonical unresolved questions; and the
  fields the normalizer changed.
- The original submission is explicitly labelled and remains fully visible
  (title, details, category, dates, location, organizer, follow-up address,
  source link, attachments).
- `SubmissionApprovalEditor` (line 420) prefills from the draft when one exists.
  A null draft field stays empty — nothing is inferred. When there is no draft
  the previous behaviour (raw submission values) is kept, so older rows remain
  reviewable.
- The approval payload is built from what the reviewer sees. The previous
  hidden fallbacks to `submission.sourceUrl` / `submission.organizer` were
  removed so a cleared field is not silently refilled. Tags entered in the form
  are now sent (previously always `[]`).
- Approve/reject, authentication and authorization are unchanged; nothing new is
  public.

---

## 7. Approval safety fix

`endsBeforeStart(startAt, endAt)` and the fixed message live in
`src/lib/eventInterval.ts` and are used by both the submission and approval
routes. The approval route checks the parsed payload **before** the transaction
(`submissions.ts:366`), so an invalid interval returns `400
{"error":"The event end must be after its start"}` and no event is inserted and
no submission status changes. `endAt === startAt` remains valid (`endAt >=
startAt`).

---

## 8. Tests

`cd artifacts/api-server && node --test tests/*.test.ts`

```
# tests 61
# suites 6
# pass 61
# fail 0
```

| File | Tests | Covers |
| --- | --- | --- |
| `tests/normalizer.test.ts` | 45 | Phase 1 contract and rules (unchanged, all still pass) |
| `tests/submission-normalization.test.ts` | 8 | mapping, private-data exclusion, flags instead of guesses, provider failure, write failure, legacy rows, stored-draft re-validation, status vocabulary |
| `tests/submissions-route.test.ts` | 8 | interval guard, approval handler rejection before any DB call, incomplete body, post-commit step cannot throw, response contract, legacy rows, corrupt draft, no follow-up-email leak |

How the route tests work: the API server imports modules without file
extensions (esbuild resolves them), which Node's type stripping cannot do. The
test bundles the real `routes/submissions.ts` with the package's existing
`esbuild` devDependency, imports the bundle with `DATABASE_URL` pointed at a
closed local port, and calls the approval handler directly (skipping the Clerk
middleware). The invalid-interval branch returns before any query, so no
database is needed. `submissionResponse` is exported for the response-contract
tests, which parse the result with the generated `ListSubmissionsResponse`.

Directly covered requirements:

- a valid submission is not affected by a normalization failure (post-commit
  step cannot throw and logs a safe message);
- successful normalization is represented separately from the raw row;
- private follow-up data never enters the draft, the columns or the admin
  normalization payload;
- normalization failure cannot publish (it only writes the submission row);
- the approval endpoint rejects `endAt < startAt` before any insert;
- older rows with null normalization fields stay readable;
- existing normalizer tests still pass.

---

## 9. Commands run (exact)

The sandbox started without `node_modules`. To run real checks, the workspace
dependencies were installed from the committed lockfile:

```
pnpm install --frozen-lockfile --ignore-scripts
```

`pnpm-lock.yaml` and every `package.json` are unchanged; `node_modules` is
gitignored. `pnpm` itself was installed globally in the sandbox only.

| # | Command | Result |
| --- | --- | --- |
| 1 | `cd artifacts/api-server && node --test tests/*.test.ts` | `# tests 61`, `# pass 61`, `# fail 0`, exit 0 |
| 2 | `cd artifacts/api-server && npm test` | same: 61/61, exit 0 |
| 3 | `pnpm run typecheck` (workspace: `tsc --build` + api-server, calendar, mockup-sandbox, scripts) | exit 0, no diagnostics |
| 4 | `pnpm --filter @workspace/api-spec run codegen` | orval 8.30.0 + `tsc --build`; regenerated files identical to the committed ones (empty `git status`) |
| 5 | `pnpm --filter @workspace/api-server run build` | esbuild bundle written, exit 0 |
| 6 | `PORT=5000 BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/tumbler-ridge-calendar run build` | vite build, 1792 modules, exit 0 |
| 7 | temporary `tsc -p tsconfig.testcheck.json` over the normalizer, the new lib modules and all test files | exit 0 (this is not part of the repository config; the file was removed afterwards) |
| 8 | throwaway probe calling `normalizeAndStore` on a realistic row and `readStoredNormalization` on the result | `stored: true`, status `needs_review`, flags `category_uncertain`, `contact_not_public`, `registration_url_ambiguous`, `cost: "$10"`, private email absent |

---

## 10. Not verified / limitations

1. **No database was available.** `drizzle-kit push` was not run, no SQL was
   executed, and no table was altered. The schema change is repository-only.
2. **No DB-backed integration test.** The successful `INSERT`-then-`UPDATE`
   path, attachment claim atomicity, admin authentication, the PATCH route and
   the approve success path were not executed. They are unchanged except for the
   new post-commit step and the interval guard, both exercised in isolation.
3. **The approval test bypasses Clerk** by calling the route handler directly,
   and only covers the invalid-interval, invalid-body and pre-insert behaviour.
4. **The post-commit test uses an unreachable database**, so it proves the
   failure path (no throw, safe log). A successful write is covered by unit
   tests with an injected update function, not by PostgreSQL.
5. **No browser/UI test.** The admin panel and editor were verified by
   typecheck, the production build and code review, not by a rendered session.
6. **Node 24 was not exercised.** The sandbox runs Node v22.22.3; native type
   stripping is stable in both, but the exact Node 24 run was not observed.
7. **P2-8 remains open** (`validateDraft` still accepts semantically bogus
   `cost`/`contact`, `title: "123"`, localhost URLs). No non-rules provider is
   enabled; this must be resolved before one is.
8. **No re-run endpoint.** A submission whose normalization failed is visible
   as failed but cannot be re-normalized from the UI; that is Phase 3 work
   (`POST /admin/submissions/:id/normalize`).
9. **Flyer-only submissions are not OCR'd**, so they normalize from whatever
   text the submitter typed. A submission with no text at all still produces a
   draft, but every field is null and flagged (`missing_title`, `missing_date`,
   …); there is no `skipped_no_text` state.
10. **Deploy order matters:** schema push first, then the server, then the UI.
    The reverse order breaks the admin submission list.

### Divergences from the integration audit

- Flags are not duplicated in a separate `normalization_flags` column; they are
  read from the validated draft.
- The audit's proposed statuses (`succeeded`, `skipped_no_text`, …) were not
  adopted; the established Phase 1 contract statuses are used, plus the
  storage-only `not_run`.
- `submissionResponse` now maps fields explicitly (audit §2.5 recommended this;
  it became necessary once the row gained columns).
- No `POST /admin/submissions/:id/normalize`, no audit/history table, no OCR.

---

## 11. Scope confirmation

Changed files (implementation commit `3462705`):

```
lib/db/src/schema/community.ts
artifacts/api-server/src/lib/eventInterval.ts                  (new)
artifacts/api-server/src/lib/submissionNormalization.ts        (new)
artifacts/api-server/src/routes/submissions.ts
artifacts/api-server/tests/submission-normalization.test.ts    (new)
artifacts/api-server/tests/submissions-route.test.ts           (new)
lib/api-spec/openapi.yaml
lib/api-zod/src/generated/**                                   (regenerated)
lib/api-client-react/src/generated/api.schemas.ts              (regenerated)
artifacts/tumbler-ridge-calendar/src/App.tsx
```

- No authentication, upload-token, storage-ACL or publication-policy change.
- No OCR, model provider, API key, paid service or dependency added.
- No migration file or migration system added; no database command executed.
- No deploy, no merge into `main`, no destructive git operation.
- The normalizer still runs only through its provider-neutral interface, and
  the human approval gate is unchanged.
