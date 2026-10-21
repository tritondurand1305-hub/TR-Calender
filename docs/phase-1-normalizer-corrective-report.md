# Phase 1 normalizer — corrective pass

**Branch:** `arena/ba533186-tr-calender`
**Base:** `10f7a14` (review report), branched from `6b65325`
**Date:** 2026-10-20
**Scope:** the four P1 findings and the listed P2 findings in
`docs/phase-1-normalizer-review.md`, plus the test-command documentation fix.
No database, API, UI, auth, storage or publication code was touched.

---

## 1. Outcome

| Finding | Status |
| --- | --- |
| P1-1 cost treats compounds and partial offers as free admission | **Fixed** |
| P1-2 unrelated dollar amounts become admission prices | **Fixed** |
| P1-3 personal contact promoted unflagged, cross-sentence frame bleed | **Fixed** |
| P1-4 `validateDraft` accepts impossible / out-of-range timestamps | **Fixed** |
| P2-1 registration URL misattributed from nearby info links | **Fixed** |
| P2-2 registration URL after a label on the next line missed | **Fixed** |
| P2-3 unparsed date expression unflagged when a structured date exists | **Fixed** |
| P2-4 title casing mangles `LEGO`, `COVID-19`, `2SLGBTQ+`, `STEM`, `A&B` | **Fixed** |
| P2-5 accepted abort signal ignored | **Fixed** |
| P2-6 `producedAt` misrepresents the reference time | **Fixed** (renamed and documented) |
| P2-7 provider flag messages/questions can inject arbitrary text | **Fixed** (canonical messages, questions derived from codes) |
| P2-8 validator accepts semantically bogus cost/contact, `title:"123"`, localhost URLs | **Not fixed — outside the requested scope; recorded as a limitation** |
| P2-9 `normalized` is not a safety signal | **Documented** (no behaviour change) |
| P3-12 “50/50” treated as a date expression | **Fixed** as required collateral of P2-3 (otherwise broadening the flag would create a new false positive) |
| P3-1 … P3-11 | Not addressed (no unrelated cleanup) |
| Follow-up (post-review) — numeric dates without a year missed while avoiding `50/50` | **Fixed — see §9** |

Tests went from **29 to 44** in this pass, and to **45** after the follow-up
micro-correction in §9; all passing. The module stays deterministic,
offline and dependency-free.

---

## 2. Files changed

| File | Change |
| --- | --- |
| `artifacts/api-server/src/lib/normalizer/types.ts` | canonical flag messages/questions; three append-only flag codes; `cancelled` status/error; `referenceTime` (was `producedAt`); strict `isCanonicalIsoTimestamp`; canonicalisation of provider flags and questions |
| `artifacts/api-server/src/lib/normalizer/rules.ts` | new cost classifier; per-match contact context; registration label/connector logic; date-expression flag; canonical flag text; tightened numeric date pattern |
| `artifacts/api-server/src/lib/normalizer/text.ts` | acronym list; digit/symbol token preservation in `titleCase` |
| `artifacts/api-server/src/lib/normalizer/index.ts` | cancellation handling; `referenceTime`; documentation of both |
| `artifacts/api-server/tests/normalizer.test.ts` | header command fixed; 15 regression tests added; strict-timestamp assertions added |
| `docs/phase-1-normalizer-corrective-report.md` | this report |

No other file changed. `package.json` already contained the working command
(`"test": "node --test tests/*.test.ts"`), so the documentation was brought in
line with it rather than changing the script.

---

## 3. Findings and fixes

### P1-1 — compounds and partial offers were treated as free admission

**Implementation:** `rules.ts:341` (`classifyFree`) and `rules.ts:364`
(`extractCost`).

Cost is now decided per sentence/line segment with three signals:

1. **Explicit admission context** is required for any dollar amount
   (`ADMISSION_COST_CONTEXT`: admission, entry, entrance, tickets, cover, at
   the door, price, fee, per person, …). A bare amount is never a price.
2. **Free wording is classified.** `FREE_CLAIM` ignores hyphenated compounds
   (`smoke-free`, `gluten-free`), negation is rejected, `free for <subgroup>`
   (`FREE_SUBGROUP`) and unrelated freebies (`FREE_UNRELATED`: parking, snacks,
   coffee, childcare, …) are not admission-free. Free admission requires an
   explicit subject + copula/colon (`Admission is free`, `Tickets: free`), the
   `free <admission-noun>` shape (`Free admission`), or a segment that is only
   `Free`.
3. **Resolution order:** one distinct explicit price wins (even alongside a
   free subgroup); two distinct prices, or an explicit price together with an
   explicit free-admission claim, return `null` with `cost_ambiguous` instead
   of guessing. Donations remain `By donation` and never override a fixed
   price.

Regression tests:

- `never treats a compound word or a subgroup offer as free admission`
  (“This is a smoke-free event. Tickets are $10.” → `$10`;
  “Admission is $10; free for children under 5.” → `$10`;
  “Free parking for families at the arena.” → `null` + `cost_unclear`;
  “Tickets are $10; free for students.” → `$10`).
- `flags conflicting cost statements instead of guessing`
  (“Admission is free. Tickets are $10.” → `null` + `cost_ambiguous`;
  two adult/child prices → `null` + `cost_ambiguous`).
- `keeps donations distinct from fixed prices`.
- Existing `extracts only explicitly stated costs` still passes unchanged.

### P1-2 — any dollar amount became the admission price

**Implementation:** `rules.ts:364` (`extractCost`) with
`NON_ADMISSION_COST_CONTEXT`.

Amounts are ignored when their local window (48 characters before / 32 after)
contains fundraising, proceeds, goal, prize, gift card, voucher, value, worth,
discount, coupon, `off`, refund, deposit, raffle, 50/50, suggested, parking,
snacks, refreshments and similar wording. The amount must also have admission
context, so “Help us raise $5000” and “$15 off your first visit” produce no
price and keep `cost_unclear`.

Regression test: `does not turn unrelated dollar amounts into admission prices`
(`raise $5000`, `$15 off`, `$250 gift card`).

### P1-3 — personal contact promoted, and frame bleed across sentences

**Implementation:** `rules.ts:408` (`localContext`) and `rules.ts:425`
(`extractContact`).

Each phone and email is now evaluated independently. The context window stops
at the previous sentence boundary (`.`, `!`, `?`, `;` followed by space or a
line break) as well as at the line start, so an organizer email in the previous
sentence can no longer frame a personal phone. First-person wording
(`me`, `my`, `mine`, `myself`) blocks promotion and adds `contact_not_public`.
A value that would push the joined contact past `LIMITS.contactMax` is dropped
with `contact_invalid` instead of failing the whole normalization. The
follow-up email is still never read.

Regression tests:

- `evaluates each contact detail on its own local context`
  (“Call me at 250-555-1234.” → `null` + `contact_not_public`;
  “Contact Jane at jane@example.org. My cell is 250-555-1234.” →
  `jane@example.org` + `contact_not_public`, never combined;
  “My cell is 250-555-1234.” → `null` + flag).
- `drops an over-long contact detail with a flag instead of failing`
  (202-character framed email → `needs_review`, `contact: null`,
  `contact_invalid`).

### P1-4 — impossible and out-of-range timestamps accepted by `validateDraft`

**Implementation:** `types.ts:342` (`isCanonicalIsoTimestamp`) and
`types.ts:508` (`validateDraft` via `readNullableTimestamp`).

`isCanonicalIsoTimestamp` now round-trips through `canonicalIsoTimestamp`, the
same parser the producer uses. `2026-02-30` no longer rolls to March 2, and
years outside 1900–2200 are rejected. `validateDraft` is therefore exactly as
strict as the producer for timestamps, and a provider returning an impossible
date now fails normalization instead of producing a draft.

Regression tests:

- `enforces the strict draft contract` extended with `2026-02-30`,
  `0001-01-01` and `9999-12-31`, each with `endAt: null` so the timestamp check
  is isolated from the interval rule.
- `rejects impossible and out-of-range timestamps from a provider` — three
  providers return a draft with one impossible `startAt`; every result is
  `failed` / `invalid_provider_output` / `draft: null`.

### P2-1 — information links attributed as registration URLs

**Implementation:** `rules.ts:458` (`registrationConnector`) and
`rules.ts:477` (`extractRegistrationUrl`).

A URL is accepted only when the nearest preceding registration/ticket label
(`register`, `registration`, `rsvp`, `sign up`, `reserve`, `booking`,
`tickets`) is separated from it by at most 48 characters, with no sentence
punctuation and no information label (`more info`, `info`, `details`,
`source`, `learn more`, `website`, `event page`, …). Otherwise the link is not
used; if a registration label was present at all, `registration_url_ambiguous`
is added. Multiple distinct candidates also produce `null` plus that flag.

Regression test: `does not misattribute an information link as the
registration link` (“Register at the hall. More info:
https://example.org/info” → `null` + `registration_url_ambiguous`).

### P2-2 — registration link on the next line

**Implementation:** `rules.ts:458`, next-line branch.

If the URL is the only content on its line, the previous non-empty line must
end with a registration/ticket label (optionally followed by a colon). The
connector is then empty, so “Register:” followed by
`https://example.org/rsvp` is accepted. A URL line such as `Info: <url>`
immediately after “Register:” is not accepted, because that line supplies its
own non-registration label.

Regression test: `reads a registration link placed on the line after its
label`.

### P2-3 — an unparsed date expression was unflagged when a structured date existed

**Implementation:** `rules.ts:603-610` (`buildDraft`).

`date_expression_unresolved` is now raised whenever a month/day or full
numeric date appears in the prose, regardless of whether `startAt` is present.
Relative expressions keep `relative_date_unresolved` and suppress the
duplicate. The canonical message is phrased as a confirmation (“The text
contains a date that was not converted; confirm the exact date and time.”) and
never claims a conflict, because the two values are never compared.

The numeric-date expression was tightened to require a full
`d/m/yyyy`-shaped date, so “50/50” no longer matches (P3-12).

Regression tests:

- `flags an unparsed date expression even when a structured date exists`
  (structured 2026-11-07 + “October 24” → flag, canonical message contains no
  “conflict”/“mismatch” wording).
- `does not read a fundraising split as a date expression`.

### P2-4 — all-caps title casing mangled acronyms and brand tokens

**Implementation:** `text.ts:62` (`ACRONYMS`) and `text.ts:195` (`titleCase`).

`LEGO`, `STEM`, `COVID`, `LGBTQ` were added to the acronym set. Tokens that
contain a digit, `&` or `+` have no inferable casing and are now kept exactly
as supplied, which covers `COVID-19`, `2SLGBTQ+`, `A&B` and `A1`. Mixed-case
input is still only first-letter capitalised, so `iPhone` and `eBay` remain
untouched.

Regression test: `preserves acronyms and brand casing in all-caps titles`
(`LEGO BUILDERS CLUB`, `COVID-19 UPDATE`, `2SLGBTQ+ PRIDE NIGHT`, `STEM CAMP`,
`A&B CRAFT SALE`).

### P2-5 — the abort signal was accepted and forwarded but ignored

**Implementation:** `index.ts:15-20` (documentation), `index.ts:72-81`
(already-aborted check), `index.ts:107-136` (post-provider checks).

An already-aborted signal returns `status: "cancelled"`, `error.code:
"cancelled"`, `draft: null` **before** the reference time or input is read. If
the signal aborts while the provider runs, the result is discarded and the same
cancelled result is returned — both when the provider resolves and when it
throws. The module documents the limitation plainly: JavaScript cannot
interrupt a running provider, so a provider that ignores the signal still runs
to completion; the wrapper only guarantees it can never be returned as a
successful draft.

Regression tests: `honours an already-aborted signal before doing any work`
and `discards provider output when cancelled during execution`.

### P2-6 — `producedAt` was the reference time, not a production time

**Implementation:** `types.ts` (`NormalizationResult`), `index.ts` (all
returns), tests.

The field was renamed to `referenceTime` and documented as “the supplied
submission/reference timestamp, canonicalised to ISO 8601; not a wall-clock
production time”. The normalizer still never reads the clock. All usages were
updated in the same change: the four `NormalizationResult` construction sites
in `index.ts` and the three assertions in the test file. Nothing outside the
normalizer module referenced the field (`grep -rn producedAt` finds only the
historical review and audit documents).

### P2-7 — provider messages could inject arbitrary text or PII

**Implementation:** `types.ts:73` (`REVIEW_FLAG_MESSAGES`), `types.ts:98`
(`REVIEW_FLAG_QUESTIONS`), `types.ts:508` (`validateDraft`), `types.ts:730`
(`readReviewFlags`).

Every flag code now has one application-owned message and question.
`validateDraft` still validates the provider's shape (known code, non-empty
bounded string), then **replaces** the message with the canonical text.
`unresolvedQuestions` is rebuilt from the flag codes, so provider-supplied
question prose is validated and discarded. Two provider messages for the same
code, or a provider question not tied to a flag, cannot reach the review UI.

Regression test: `replaces provider flag messages and questions with canonical
text` (a provider returns a message containing a phone number, an email address
and a fake secret; the serialised result contains none of them).

### P2-9 — `normalized` is not a safety signal

No behavioural change. The status union is documented at its definition as
“a valid draft with no review flags”, and the module continues to state that
human review is mandatory for every result. `normalized` still does not mean
verified, approved or publishable.

---

## 4. Contract changes introduced by this pass

These are deliberate and confined to the normalizer contract:

1. `NormalizationStatus` gains `"cancelled"`; `NormalizationErrorCode` gains
   `"cancelled"`.
2. `NormalizationResult.producedAt` → `referenceTime` (same value, honest
   name).
3. Three append-only flag codes: `contact_invalid`, `cost_ambiguous`,
   `registration_url_ambiguous`. Existing codes and their order are unchanged.
4. `REVIEW_FLAG_MESSAGES` and `REVIEW_FLAG_QUESTIONS` are exported from the
   contract module; `validateDraft` overwrites provider text with them.
5. `isCanonicalIsoTimestamp` is now a round-trip check against
   `canonicalIsoTimestamp` rather than a regex plus `Date.parse`.

No caller outside `src/lib/normalizer/**` and `tests/**` exists yet, so the
rename is contained.

---

## 5. Commands run and results

All commands were run from the repository root unless stated otherwise.

| # | Command | Result |
| --- | --- | --- |
| 1 | `cd artifacts/api-server && node --test tests/*.test.ts` | `# tests 44`, `# pass 44`, `# fail 0`, exit 0 |
| 2 | `cd artifacts/api-server && npm test` | same 44/44, exit 0 (script is `node --test tests/*.test.ts`) |
| 3 | `cd /tmp/tscprobe && ./node_modules/.bin/tsc -p tsconfig.repo.json` | exit 0, no diagnostics. The temporary project extends the repo `tsconfig.base.json` and includes `artifacts/api-server/src/lib/normalizer/**/*.ts` plus `artifacts/api-server/tests/**/*.ts`, with `allowImportingTsExtensions` and `noEmit` |
| 4 | `cd /tmp/tscprobe && ./node_modules/.bin/esbuild …/src/lib/normalizer/index.ts --bundle --format=esm --platform=node --outfile=/tmp/corrective/normalizer.mjs --log-level=warning` | exit 0; the bundle imports successfully and exposes 19 exports |
| 5 | `node /tmp/corrective/probe.ts` (throwaway probe outside the repository) | see §6 |
| 6 | `git status --porcelain` / `git diff --stat` | 5 modified source/test files plus this report; no schema, route, UI, OpenAPI or generated file |

The follow-up in §9 re-ran the same commands after its change: **45/45**,
`tsc` exit 0, `esbuild` exit 0.

`tsc` and `esbuild` are the out-of-tree binaries already present in
`/tmp/tscprobe` from the implementation phase (TypeScript 5.9.3, esbuild
0.28.2). No dependency was added to the repository.

All 29 pre-existing tests still run. Their only edits are the three
`producedAt` assertions renamed to `referenceTime` (required by P2-6), the
extra impossible-timestamp assertions inside `enforces the strict draft
contract`, and the header comment. No assertion was weakened.

The test header now documents the working command:

```
 * Run from `artifacts/api-server` with: node --test tests/*.test.ts
 * (`npm test` runs the same command.) A bare directory argument is not a valid
 * test selector on every supported Node version, so the shell expands the glob.
```

---

## 6. Corrected reproductions

Probe output with the fixed code (same inputs as the review reproductions):

| Input | Result |
| --- | --- |
| “This is a smoke-free event. Tickets are $10.” | cost `$10` |
| “Admission is $10; free for children under 5.” | cost `$10` |
| “Free parking for families at the arena.” | cost `null`, `cost_unclear` |
| “Tickets are $10; free for students.” | cost `$10` |
| “Help us raise $5000 for the new playground.” | cost `null`, `cost_unclear` |
| “Use this coupon for $15 off your first visit.” | cost `null`, `cost_unclear` |
| “Call me at 250-555-1234.” | contact `null`, `contact_not_public` |
| “Contact Jane at jane@example.org. My cell is 250-555-1234.” | contact `jane@example.org`, `contact_not_public` |
| Happy path (`Admission is free`, no date text) | `normalized`, no flags, cost `Free` |
| `validateDraft` with `2026-02-30` / `0001-01-01` / `9999-12-31` (`endAt: null`) | `false`, `false`, `false` |
| Provider returns `2026-02-30T10:00:00.000Z` | `failed` / `invalid_provider_output` / `draft: null` |
| Provider flag message `jane@example.org 250-555-1234` | canonical “No admission cost was stated…” |
| “Register at the hall. More info: https://example.org/info” | registration `null`, `registration_url_ambiguous` |
| “Register:” newline “https://example.org/rsvp” | registration `https://example.org/rsvp` |
| Structured 2026-11-07 + “October 24” | `date_expression_unresolved`, confirmation wording |
| Already-aborted signal | `cancelled` / `cancelled` / `referenceTime: null` |
| `LEGO BUILDERS CLUB` … `A&B CRAFT SALE` | `LEGO Builders Club`, `COVID-19 Update`, `2SLGBTQ+ Pride Night`, `STEM Camp`, `A&B Craft Sale` |

---

## 7. Remaining findings and limitations

1. **P2-8 is not fixed.** `validateDraft` still accepts a draft whose `cost` is
   “not a price at all”, whose `contact` is arbitrary text, whose title is
   `"123"`, or whose `sourceUrl` is `http://localhost/…`. This was outside the
   requested corrective scope. The deterministic producer cannot emit those
   values, but a future provider could; this should be closed before a
   non-rules provider is enabled.
2. **P3-1 … P3-11 remain** by design (no unrelated cleanup). The one exception
   is P3-12, fixed because broadening the date flag would otherwise have made
   “50/50” a new false positive.
3. **Node 24 was not exercised.** The sandbox runs Node v22.22.3; the Replit
   module is Node 24. Native type stripping is expected to behave the same, but
   the exact Node 24 run was not observed.
4. **No full-workspace typecheck or build.** `pnpm` is not installed in the
   sandbox and the repository has no `node_modules`. Command 3 typechecks only
   the normalizer and its tests against the repo base config; it is not a
   workspace-wide check.
5. **No integration test and no database.** The normalizer is still not wired
   into any route, so cancellation, persistence and review-UI behaviour were
   tested at the module boundary only.
6. **Cancellation during provider execution cannot interrupt the provider.**
   The wrapper discards the result and returns `cancelled`; a slow provider
   still runs to completion. This is documented in `index.ts`.
7. **Cost detection is heuristic.** Sentences are the unit of context. A price
   split across sentences, or a single sentence containing a price and a
   subgroup offer without punctuation, can still need a human. In those cases
   the module returns `null`/`cost_ambiguous` rather than guessing.
8. **Contact detection is heuristic.** A public organizer phone written with
   first-person wording (“call me”) is deliberately withheld and flagged;
   “call us” is treated as public. Recoverable by the reviewer, never silently
   published.
9. **Registration detection is deliberately conservative.** Label shapes such
   as “To register, visit:” on the previous line are not recognized and are
   missed silently (no misattribution, no flag). `registration_url_ambiguous`
   is raised only when a URL was actually seen near a label but could not be
   confirmed.
10. **The date flag is now noisier.** Any prose month/day expression raises
    `date_expression_unresolved`, even when it agrees with the structured date.
    This is intentional: Phase 1 does not compare prose dates with structured
    ones, so the flag asks for confirmation instead of claiming agreement.
11. **`normalized` still only means “valid draft with no flags”.** Human
    review remains mandatory; nothing in this pass changes publication or
    approval behaviour.

---

## 8. Scope confirmation

Only these files changed (verified with `git status --porcelain` and
`git diff --stat`):

```
artifacts/api-server/src/lib/normalizer/types.ts
artifacts/api-server/src/lib/normalizer/rules.ts
artifacts/api-server/src/lib/normalizer/text.ts
artifacts/api-server/src/lib/normalizer/index.ts
artifacts/api-server/tests/normalizer.test.ts
docs/phase-1-normalizer-corrective-report.md
```

No database schema or migration, API route, OpenAPI or generated client, admin
or public UI, authentication, upload/storage or publication/approval code was
modified or otherwise touched. No dependency was added. The normalizer is
not integrated into any request path, and this branch was not merged.

---

## 9. Follow-up micro-correction — numeric dates without a year

### Defect

The P2-3 change replaced the optional-year numeric date pattern with one that
required a year (`\d{1,2}/\d{1,2}/\d{2,4}`). That removed the `50/50` false
positive but also stopped detecting legitimate flyer dates written as `10/24`
or `9/7`.

### Fix

**Implementation:** `rules.ts:74-78` — one range-validated numeric pattern with
an optional year, replacing the year-only form:

```
\b(?:0?[1-9]|1[0-2])/(?:0?[1-9]|[12]\d|3[01])(?:/\d{2,4})?\b
```

The distinction is the calendar range (month 1–12, day 1–31), not a literal
blacklist of `50/50`. `50/50`, `75/25`, `13/1` and `1/32` do not match;
`10/24`, `10/24/2026`, `10/24/26`, `9/7`, `09/07` and `12/31` do. The pattern
is used only for detection: nothing is converted, no year is inferred, and the
structured date is never compared or changed.

Written dates (`October 24`), ISO-style dates (`2026-10-24`) and relative
expressions (`this Saturday`) behave exactly as before, and the flag is still
raised when a structured `startAt` exists.

### Tests

- New: `detects numeric month/day dates with and without a year`
  (`10/24`, `10/24/2026`, `9/7`, `12/31/26` each trigger
  `date_expression_unresolved`, and `startAt` stays unchanged).
- Extended: `does not read a fundraising split as a date expression` now also
  checks a bare `50/50` and `75/25`, demonstrating that the exclusion is
  range-based rather than text-specific.
- The existing written-date test
  (`flags an unparsed date expression even when a structured date exists`) and
  relative-date test (`leaves relative dates unresolved`) pass unchanged.

### Verification

| # | Command | Result |
| --- | --- | --- |
| 1 | `cd artifacts/api-server && node --test tests/*.test.ts` | `# tests 45`, `# pass 45`, `# fail 0`, exit 0 |
| 2 | `cd artifacts/api-server && npm test` | same 45/45, exit 0 |
| 3 | `cd /tmp/tscprobe && ./node_modules/.bin/tsc -p tsconfig.repo.json` | exit 0, no diagnostics (normalizer + tests; not a workspace-wide check) |
| 4 | esbuild bundle of `normalizer/index.ts` | exit 0 |

### Limitations

- Small ratios that are also valid calendar values (`3/4 cup`, `1/2 price`)
  match and produce a confirmation flag. This is accepted: the flag asks a
  human to confirm the date and never changes or converts anything.
- Day-first numeric dates (`24/10`) are deliberately not matched. Supporting
  them would make `24/7` (“open 24/7”) a false date expression, and the
  requirement is month/day.
- No year is inferred and no prose date is converted; the flag remains a
  consistency question, not a conflict claim.

### Scope

This follow-up changed only `rules.ts`, `tests/normalizer.test.ts` and this
report. No schema, migration, route, OpenAPI/generated file, UI, auth, storage
or publication code was touched; no dependency was added.
