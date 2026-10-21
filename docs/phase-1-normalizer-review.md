# Phase 1 Normalizer — Adversarial Code Review

**Repository:** `tritondurand1305-hub/TR-Calender`  
**Branch reviewed:** `arena/ba533186-tr-calender`  
**Commits reviewed:** `8215414` (normalizer, tests, tsconfig/package changes), `7ad6995` (restored `docs/event-format-rules.md`)  
**Review date:** 2026-10-20  
**Review type:** read-only code review plus out-of-tree probes. No application code, tests, schema, configuration, dependency, lockfile or generated file was modified. The only repository change is this report.

---

## 1. Executive verdict

**Verdict: not ready as committed — ready after fixes (a small, localized set of P1 changes).**

There is **no P0**: the module cannot publish, approve, persist, or bypass the existing human approval gate. Every result is a value returned to a caller; publication still requires `POST /api/admin/submissions/:id/approve`.

However, four **P1** defects affect what the draft can contain or accept, exactly the fields Phase 2 is designed to surface and prefill:

1. Paid events can be labelled **“Free”** (`smoke-free`, `$10; free for children`).
2. Unrelated dollar amounts become the price (`raise $5000`, `$15 off`).
3. First-person contact details are promoted to the public contact field **without a flag**, and a framed public contact causes a nearby personal phone number to be joined into the same field.
4. `validateDraft`, the trust boundary for every future provider, accepts **impossible and out-of-range timestamps** (`2026-02-30`, year `0001`) and lets `runNormalization` return them with `status: "normalized"`.

The rest of the module is in good shape: the contract is explicit, deterministic, bounded, and well tested for ordinary cases; failure handling is safe for ordinary JSON input; the integration shape matches the submission route; and the reported 29 tests do pass. All four P1s are confined to `extractCost`, `extractContact`, and `isCanonicalIsoTimestamp`, so the verdict can be reversed without redesign.

**Conditions to change the verdict to “ready for integration”:**

- Fix P1-1 through P1-4 and add the regression tests in §5.
- Fix P2-1 (registration misattribution) and P2-3 (silent date conflict) before the admin UI starts showing drafts as if they were checked.
- Decide and document the semantics of `producedAt` (P2-6) and the ignored abort signal (P2-5) before any async provider exists.

---

## 2. Method and scope

Reviewed files:

- `docs/event-format-rules.md` (policy, 118 lines)
- `docs/event-normalizer-integration-audit.md` (architecture and Phase 1/2 plan)
- `artifacts/api-server/src/lib/normalizer/{types,text,rules,index}.ts`
- `artifacts/api-server/tests/normalizer.test.ts`
- `artifacts/api-server/package.json`, `artifacts/api-server/tsconfig.json`
- `artifacts/api-server/src/routes/submissions.ts` (input shape, duplicate computation, validation order)
- `lib/db/src/schema/community.ts` (submission column types)
- `lib/api-spec/openapi.yaml` (`SubmissionInput`, `SubmissionApprovalInput`)
- `lib/api-zod/src/generated/api.ts` (actual coercion of `startAt`)
- `artifacts/tumbler-ridge-calendar/src/App.tsx` (what the approval editor actually prefills)

Evidence was collected by reading the code and running throwaway probes under `/tmp` against the module itself. The probes exercised the exact public API. No repository dependency was installed during this review; the TypeScript/esbuild binaries used for out-of-tree checks were already present under `/tmp/tscprobe` from the implementation phase.

**Commands and results are listed in §8.** The implementation's claimed 29 passing tests were re-run and confirmed.

---

## 3. Findings

Findings are ordered by severity. “Confidence: high (reproduced)” means the behaviour was observed in a probe against the committed module.

### P1-1 — Paid events can be labelled “Free” from a compound or a free sub-offer

**Severity:** P1 · **Confidence:** High (reproduced)  
**Location:** `artifacts/api-server/src/lib/normalizer/rules.ts:137-141` (`FREE_PATTERNS`), `:335-338` (`extractCost`)

**Input A:**

```json
{ "details": "This is a smoke-free event. Tickets are $10." }
```

**Actual:** `draft.cost === "Free"`, no `cost_unclear` flag, and — because no other flag applies — `status: "normalized"`.  
**Input B:** `"Admission is $10; free for children under 5."` → `draft.cost === "Free"`, `status: "normalized"`.  
**Input C:** `"Free parking for families at the arena."` → `draft.cost === "Free"`.  
**Input D:** `"Tickets are $10; free for students."` → `draft.cost === "Free"`.  
All four return `status: "normalized"` with an empty `reviewFlags` array.

**Expected:** `"$10"` for A and D; for B either `"$10"` plus a partial-pricing flag, or `null` plus `cost_unclear`; for C `null` plus `cost_unclear` (free parking does not establish admission). Never `"Free"` when a paid price is stated or when only a sub-offer is free.

**Why it matters:** “Free” is an explicit factual claim that the policy permits only when admission is explicitly free (`event-format-rules.md:19`). “Smoke-free” is a compound, not an admission statement; “free parking”, “free for children”, and “free for students” describe a subset, not admission. Because these cases carry no flag, the reviewer sees `normalized` and a prefilled “Cost: Free” with nothing to check it against. The existing test named “extracts only explicitly stated costs” covers “Free parking is available at the arena.” but not “free parking for families”, “free for students”, `smoke-free`, or `no cost for children`, so it passes.

**Smallest fix:** Require a standalone free token with `(?<![-\w])free\b`; treat free as non-exclusive when qualified by `for kids|children|seniors|students|members|under N`; if a price is also present, prefer the price or return `null` plus `cost_unclear`.

**Regression test:**

```ts
it("does not treat smoke-free or partial-free wording as free admission", async () => {
  const smoke = await normalize(baseInput({ details: "This is a smoke-free event. Tickets are $10." }));
  assert.notEqual(smoke.draft?.cost, "Free");
  const partial = await normalize(baseInput({ details: "Admission is $10; free for children under 5." }));
  assert.notEqual(partial.draft?.cost, "Free");
});
```

---

### P1-2 — Any dollar amount becomes the admission price

**Severity:** P1 · **Confidence:** High (reproduced)  
**Location:** `artifacts/api-server/src/lib/normalizer/rules.ts:143` (`PRICE_PATTERN`), `:340-341` (`extractCost`)

**Input A:** `"We hope to raise $5000 for the playground."`  
**Actual:** `draft.cost === "$5000"`, `status: "normalized"`, no `cost_unclear`.  
**Input B:** `"Bring this coupon for $15 off your ticket."` → `draft.cost === "$15"`, `status: "normalized"`.

**Expected:** `null` plus `cost_unclear` in both cases. A price is only a price when the surrounding text frames it as admission, a ticket, a fee, or a cover charge.

**Why it matters:** A fundraising target becomes the ticket price; a discount becomes the price. Both are materially false and are not flagged. The rule (`event-format-rules.md:19`) is “exact stated price”, not “first currency amount”.

**Smallest fix:** Require a price context within ~30 characters (before or after): `admission|ticket|entry|cover|fee|cost|price|at the door|per person`. Reject contexts containing `raise|goal|donation|off|coupon|prize|value`.

**Regression test:**

```ts
it("ignores currency amounts that are not admission prices", async () => {
  const goal = await normalize(baseInput({ details: "We hope to raise $5000 for the playground." }));
  assert.equal(goal.draft?.cost, null);
  assert.ok(codes(goal).includes("cost_unclear"));
  const coupon = await normalize(baseInput({ details: "Bring this coupon for $15 off your ticket." }));
  assert.equal(coupon.draft?.cost, null);
});
```

---

### P1-3 — Personal contact details are promoted without a flag, and one framed contact captures a nearby personal phone

**Severity:** P1 · **Confidence:** High (reproduced)  
**Location:** `artifacts/api-server/src/lib/normalizer/rules.ts:154-155` (`CONTACT_FRAME`), `:350-354` (`isNearFrame`), `:356-382` (`extractContact`)

**Input A:** `"Call me at 250-555-1234 to RSVP."`  
**Actual:** `draft.contact === "250-555-1234"`, no `contact_not_public`.

**Input B:** `"Contact Jane at jane@example.org. My cell is 250-555-1234."`  
**Actual:** `draft.contact === "jane@example.org | 250-555-1234"`, no `contact_not_public`.

**Expected:** the personal details should not be promoted as public. Input A should be `null` + `contact_not_public`; Input B should contain only the public email, with a flag for the personal cell (or omit both and flag).

**Why it matters:** The policy says to flag personal contact details unless clearly intended for public event use (`event-format-rules.md:65`). “Call me” and “my cell” are first-person, not public-organizer contact. The 80-character frame window is measured across the whole line, so the word “Contact” in the previous sentence makes the personal phone “framed”. The approval editor has a “Public organizer contact” field (`App.tsx:423`), and the audit's Phase 2 plan prefills draft fields; publishing a personal number is a privacy failure.

**Smallest fix:** Look for first-person markers (`me`, `my`, `I`, `I'll`, `my cell`, `my number`) in the 20–40 characters before the match; if found, do not promote, and add `contact_not_public`. For joining email and phone, verify each match's own local frame rather than one shared window.

**Regression test:**

```ts
it("does not promote first-person contact details", async () => {
  const callMe = await normalize(baseInput({ details: "Call me at 250-555-1234 to RSVP." }));
  assert.equal(callMe.draft?.contact, null);
  assert.ok(codes(callMe).includes("contact_not_public"));

  const mixed = await normalize(baseInput({
    details: "Contact Jane at jane@example.org. My cell is 250-555-1234.",
  }));
  assert.equal(mixed.draft?.contact, "jane@example.org");
  assert.ok(codes(mixed).includes("contact_not_public"));
});
```

---

### P1-4 — `validateDraft` accepts impossible and out-of-range timestamps

**Severity:** P1 · **Confidence:** High (reproduced)  
**Location:** `artifacts/api-server/src/lib/normalizer/types.ts:269-271` (`isCanonicalIsoTimestamp`), `:559-566` (`readNullableTimestamp`)

**Input:**

```ts
const draft = (await normalizeEvent(baseInput(), { referenceTime: REF })).draft!;
validateDraft({ ...draft, startAt: "2026-02-30T10:00:00.000Z", endAt: "2026-03-05T10:00:00.000Z" });
```

**Actual:** `{ ok: true }`. `isCanonicalIsoTimestamp("2026-02-30T10:00:00.000Z")` is `true`; years `0001` and `9999` are also accepted when `endAt` is null. (With a real `endAt`, `9999` is rejected only incidentally by the interval rule, not by timestamp validation.) A provider returning that draft through `runNormalization` yields `status: "normalized"` with `draft.startAt === "2026-02-30T10:00:00.000Z"`.

**Expected:** rejected. The input normaliser already rejects the same value (`canonicalIsoTimestamp` round-trips through `Date.UTC` and restricts years to 1900–2200, `types.ts:229-267`); the validator must be at least as strict as the producer.

**Why it matters:** `validateDraft` is the documented trust boundary (“the normalizer cannot bypass” validation). It is the only check applied to future provider output and to any draft read back from storage. `Date.parse` silently rolls `2026-02-30` to `2026-03-02`, so the value that passes validation is not the value that gets stored or displayed. The existing test named “rejects invalid and impossible timestamps” only tests **input** timestamps, not `validateDraft`; the test name overstates coverage.

**Smallest fix:**

```ts
export function isCanonicalIsoTimestamp(value: string): boolean {
  return canonicalIsoTimestamp(value) === value;
}
```

This also enforces the 1900–2200 range and the explicit-offset requirement.

**Regression test:**

```ts
it("rejects impossible and out-of-range timestamps in a draft", async () => {
  const draft = (await normalize(baseInput())).draft!;
  // endAt: null isolates the timestamp check from the interval check.
  assert.equal(validateDraft({ ...draft, startAt: "2026-02-30T10:00:00.000Z", endAt: null }).ok, false);
  assert.equal(validateDraft({ ...draft, startAt: "0001-01-01T00:00:00.000Z", endAt: null }).ok, false);
  assert.equal(validateDraft({ ...draft, startAt: "9999-12-31T23:59:59.000Z", endAt: null }).ok, false);
});
```

---

**Related — verified as intended (not counted as a defect):** `validateDraft` *does* enforce the interval (`types.ts:492-499`): an end-before-start draft is rejected **unless** it carries the `end_before_start` flag. That is why the rules provider (which always adds the flag) yields `needs_review` rather than `invalid_provider_output`, and why the test "preserves an end-before-start interval and flags it" passes. Doc line 55 calls this a "validation failure requiring review"; the implementation satisfies the "requiring review" half and is defensible. The residual risk is self-certification: a future provider can return an invalid interval together with the flag and pass validation. That draft is still `needs_review` and cannot publish without a human, so it is not a P1. A stricter design would reject unflagged **and** silently repaired intervals, or make the interval "flag-only" (accept but never `normalized`).

### P2-1 — Registration URL is attributed from any nearby link

**Severity:** P2 · **Confidence:** High (reproduced)  
**Location:** `artifacts/api-server/src/lib/normalizer/rules.ts:159-160`, `:384-401`, `:350-354`

**Input:** `"Register at the hall. More info: https://example.org/info"`  
**Actual:** `draft.registrationUrl === "https://example.org/info"`.

**Expected:** `null` (no link was offered for registration). The registration frame is 120 characters wide on the same line, so any later URL inherits it.

**Why it matters:** The draft can send the public to an information page as if it were the registration page. This is a published-link correctness issue and is not flagged.

**Smallest fix:** For registration only, require the frame immediately before the URL (e.g., `register(?:ation)?\s*(?:at|via|here:?)?\s*` within ~20 characters), and reject a candidate when words such as `info|details|more|website|source` appear between the frame and the URL.

**Regression test:**

```ts
it("does not treat an information link as a registration link", async () => {
  const result = await normalize(baseInput({
    details: "Register at the hall. More info: https://example.org/info",
  }));
  assert.equal(result.draft?.registrationUrl, null);
});
```

---

### P2-2 — Registration link on the next line is not detected

**Severity:** P2 · **Confidence:** High (reproduced)  
**Location:** `artifacts/api-server/src/lib/normalizer/rules.ts:350-354` (`isNearFrame` resets at `\n`), `:384-401`

**Input:**

```
Register:
https://example.org/rsvp
```

**Actual:** `draft.registrationUrl === null` (no flag).  
**Expected:** the URL is extracted, or at minimum flagged as an unresolved registration link.

**Why it matters:** “Register:” followed by a link on the next line is a common flyer layout. The admin must retype it; there is no signal that a registration URL exists.

**Smallest fix:** For registration, scan back across the previous non-empty line (up to 120 characters) instead of clamping at `\n`.

**Regression test:** the input above, asserting `registrationUrl === "https://example.org/rsvp"`.

---

### P2-3 — A structured date and a conflicting date in the text are silently accepted

**Severity:** P2 · **Confidence:** High (reproduced)  
**Location:** `artifacts/api-server/src/lib/normalizer/rules.ts:488-492`

**Input:**

```json
{
  "startAt": "2026-11-07T17:00:00.000Z",
  "details": "Join us October 24 at the hall."
}
```

**Actual:** no date-related flag; status is `needs_review` only because of `cost_unclear`.

**Expected:** a review flag. The policy is explicit: “If weekday and date conflict, or two sources disagree, flag the conflict instead of choosing silently” (`event-format-rules.md:50`). Phase 1 does not parse text dates, so it cannot decide which is correct — but silence implies the structured date was checked against the text, which it was not.

**Why it matters:** A wrong structured date can be published while the correcting text sits in the description. The admin has no signal to compare them.

**Smallest fix:** Emit `date_expression_unresolved` whenever a date-like expression is present and was not converted, regardless of whether `startAt` exists; word the question as “confirm this matches the start date”. This does not require parsing.

**Regression test:** the input above, asserting the flag and a question mentioning the date.

---

### P2-4 — ALL-CAPS title casing mangles unlisted acronyms and brand names

**Severity:** P2 · **Confidence:** High (reproduced)  
**Location:** `artifacts/api-server/src/lib/normalizer/text.ts:62-65` (`ACRONYMS`), `:176-205` (`normalizeTitleCapitalization`, `titleCase`)

**Inputs and actual output:**

| Input | Output |
|---|---|
| `LEGO BUILDERS CLUB` | `Lego Builders Club` |
| `COVID-19 UPDATE` | `Covid-19 Update` |
| `2SLGBTQ+ PRIDE NIGHT` | `2Slgbtq+ Pride Night` |
| `STEM CAMP` | `Stem Camp` |
| `A&B CRAFT SALE` | `A&b Craft Sale` |
| `MULTI-CULTURAL FESTIVAL` | `Multi-cultural Festival` |

**Expected:** preserve acronyms/brands (`LEGO`, `COVID-19`, `2SLGBTQ+`, `STEM`) or leave the original casing and flag an all-caps title for review. `A&B` must not become `A&b`.

**Why it matters:** The core rule is to fix presentation “without changing the facts”. Brand and acronym casing are part of the name; `2Slgbtq+` is also an insensitive rendering. `changedFields` records that the title changed, but not what was changed, so the admin must notice the difference.

**Smallest fix:** Do not lowercase tokens that contain digits or `&`/`+`; expand the acronym policy or, safer, stop recasing ALL-CAPS titles and add an `all_caps_title` review flag instead.

**Regression test:** assert `LEGO BUILDERS CLUB`, `COVID-19 UPDATE`, `2SLGBTQ+ PRIDE NIGHT`, and `A&B CRAFT SALE` retain their acronyms/casing.

---

### P2-5 — The abort signal is accepted and forwarded but never honoured

**Severity:** P2 · **Confidence:** High (reproduced)  
**Location:** `artifacts/api-server/src/lib/normalizer/index.ts:81-86` (signal forwarded), no `aborted` check anywhere in the wrapper

**Input:** `normalizeEvent(baseInput(), { referenceTime: REF, signal: controller.signal })` with `controller.abort()` called first.  
**Actual:** `status: "normalized"`, draft returned.  
**Expected:** a documented cancellation result (for example `failed` with a `cancelled` error code) or at least a pre-call check. A caller cannot rely on the signal to stop work, and the contract does not say it is advisory.

**Why it matters:** Phase 2 may pass an HTTP request signal. The wrapper will still run the provider and return a draft after the client disconnects; an async provider may do wasted work. The current deterministic provider is fast, so this is not urgent, but the interface promises more than it delivers.

**Smallest fix:** Check `options?.signal?.aborted` before parsing and before calling the provider; return a fixed failure result (or add a `cancelled` status) and document that providers must check the signal themselves.

**Regression test:** aborted controller → `status === "failed"` (or the chosen documented status), `draft === null`.

---

### P2-6 — `producedAt` is the reference time, not the production time

**Severity:** P2 · **Confidence:** High (verified by reading and probe)  
**Location:** `artifacts/api-server/src/lib/normalizer/types.ts:200-204`; `index.ts:64-66`, `:112-118`

**Input:** `referenceTime: "1999-01-01T00:00:00.000Z"`  
**Actual:** `producedAt === "1999-01-01T00:00:00.000Z"` (and a future reference time is echoed unchanged).

**Expected:** a field named `producedAt` should describe when the draft was produced, or be renamed to `referenceTime`/`evaluatedAt`. The doc comment does explain the echo, but the field name is what downstream code will use.

**Why it matters:** Phase 2 is expected to persist a draft with `normalized_at`. If it stores `producedAt`, the audit trail records the submission time (or an arbitrary caller value) as the normalization time. Determinism is valuable; misleading metadata is not.

**Smallest fix:** Rename to `referenceTime` and add a separate caller-supplied `normalizedAt` in Phase 2, or document the echo in the public interface and never use it as a production timestamp.

**Regression test:** assert `producedAt === canonical referenceTime` and add an explicit test that documents the intended semantics (after renaming).

---

### P2-7 — The validator accepts arbitrary flag messages and questions

**Severity:** P2 · **Confidence:** High (reproduced)  
**Location:** `artifacts/api-server/src/lib/normalizer/types.ts:633-645` (`readReviewFlags`), `:672-700` (`readQuestions`)

**Input:** a provider returns `{ code: "missing_location", message: "call jane at 250-555-1234" }`.  
**Actual:** `runNormalization` returns `status: "needs_review"` and the message is preserved.

**Expected:** flag messages are fixed per code (as the module's own provider does), or the validator regenerates them from the code and ignores provider prose.

**Why it matters:** The deterministic provider is safe today, but the validator is the boundary for future providers. A provider can echo raw submission text (email addresses, phone numbers, instruction-like content) into the admin UI and any stored draft. The module claims “fixed, safe message” in the type comment, but does not enforce it.

**Smallest fix:** Move the canonical `FLAG_MESSAGES` map into `types.ts` (or a shared module), and either require exact equality or replace incoming messages with the canonical text.

**Regression test:** provider returns a PII message → result must not contain the PII (either rejected or replaced).

---

### P2-8 — The validator accepts semantically bogus public fields and localhost URLs

**Severity:** P2 · **Confidence:** High (reproduced)  
**Location:** `artifacts/api-server/src/lib/normalizer/types.ts:285-298` (`isValidHttpUrl`), `:527-557` (`readNullableString`, `readNullableUrl`)

**Inputs:** `title: "123"`, `cost: "not a price at all"`, `contact: "ask at the desk"`, `sourceUrl: "http://localhost:1106/internal"`, `sourceUrl: "https://exa\nmple.com/event"` — all pass `validateDraft`.

**Expected:** a title must contain letters and meet the minimum length; cost must match the public cost vocabulary (`Free`, a currency amount, `By donation`, or a short stated-price phrase); contact must contain an email or phone shape; source/registration URLs must not contain control characters and should not point at loopback/private hosts.

**Why it matters:** These are public fields. A future provider (or a stored draft edited by another tool) can put arbitrary text into `cost`/`contact` or publish a link that resolves to the reader's own machine. The newline case is stored raw even though `new URL` strips it for validation.

**Smallest fix:** Add format checks in `validateDraft`; reject control characters in URL strings; reject loopback/private hosts (or flag them).

**Regression test:** the five inputs above must fail `validateDraft`.

---

### P2-9 — `status: "normalized"` is not a safety signal

**Severity:** P2 · **Confidence:** High (reproduced)  
**Location:** `index.ts:112`, `types.ts:180`, `:193-205`

**Input:** the smoke-free case in P1-1 (or “Free parking for families”, or “raise $5000”).  
**Actual:** `status: "normalized"`, `reviewFlags: []`, and a materially wrong `cost`.  
**Expected:** a status name that cannot be read as “approved” or “checked” (for example `no_flags`), or an explicit contract statement that `normalized` is advisory and never approval.

**Why it matters:** Phase 1 cannot publish, and the existing approval endpoint is still the only publish path (`submissions.ts:294-354`). But `normalized` is the natural signal a Phase 2 integrator would use to decide whether to prefill, highlight, or skip attention. The cost defects show that `normalized` can still be materially wrong; treating it as “clean” would silently defeat the review gate. This is a contract hazard, not a live bypass.

**Smallest fix:** Rename the status to `no_flags` (or `clean`) and document in `NormalizationStatus` and the integration audit that every result requires human approval. Do not add an `approved`-like status.

**Regression test:** an integration test that a `normalized` result still requires `POST /api/admin/submissions/:id/approve`; and a unit test documenting that `normalized` means “no flags”, using the false-cost input.

---

### P3-1 — Mixed-case shouting and leading punctuation survive title cleanup

**Severity:** P3 · **Confidence:** High (reproduced)  
**Location:** `text.ts:176-189`; `rules.ts:225-250`

**Inputs:** `"KIDS Halloween PARTY"` → unchanged; `"!!! KIDS FAIR"` → `"! Kids Fair"`.

**Expected:** normalize per-token shouting, or flag it; strip leading/trailing punctuation from titles.  
**Why it matters:** The policy says to avoid all caps; mixed-case shouting is a partial compliance gap. A leading `!` is cosmetic.

**Smallest fix:** Trim leading/trailing punctuation in `normalizeTitle`; detect per-token all-caps and either normalize or add a flag.

**Regression test:** both inputs above.

---

### P3-2 — `changedFields` misses whitespace normalization and never lists derived fields

**Severity:** P3 · **Confidence:** High (reproduced)  
**Location:** `rules.ts:238-248`, `:252-267`; `types.ts` `readStringField` trims before the normalizer sees the value

**Input:** `title: "   Spring Fair   "` → `draft.title === "Spring Fair"`, `changedFields === []`.  
**Expected:** `changedFields` includes `title` (the submitted value differed), or the contract explicitly states that input trimming is not a change.

**Why it matters:** The admin cannot see that leading/trailing whitespace was removed; more importantly, the field is a “what changed” signal and currently under-reports. `description` (derived from `details`) and extracted fields (`cost`, `contact`, `tags`, `registrationUrl`) are never listed, which is documented only in code comments.

**Smallest fix:** Compare against the untrimmed raw value, or document the trim-before-diff rule in the contract.

**Regression test:** the input above, asserting `changedFields.includes("title")` or documenting the chosen behavior.

---

### P3-3 — Summary can be cut at “p.m.” / “B.C.”

**Severity:** P3 · **Confidence:** High (reproduced)  
**Location:** `text.ts:68-73` (`SENTENCE_ABBREVIATIONS`), `:238-275` (`firstSentence`, `findSentenceEnd`)

**Input:** `"Doors open at 6 p.m. and close at 9 p.m."`  
**Actual:** summary `"Doors open at 6 p.m."` (19 characters, so the short-sentence extension does not run).  
**Expected:** the full first sentence, or at least not a cut at an abbreviation.

**Why it matters:** Summaries lose the second half of a common event sentence. Information is not false, but it is incomplete.

**Smallest fix:** Add `a.m`, `p.m`, `b.c`, `u.s` to the abbreviation set, or require the next character after a boundary to be uppercase.

**Regression test:** the input above, expecting the full sentence.

---

### P3-4 — Description keeps excessive punctuation and social chatter; spelling is not corrected

**Severity:** P3 · **Confidence:** High (reproduced)  
**Location:** `rules.ts:313-329` (description is `cleanText` of the body), `text.ts:96-137`

**Input:** `"Bring friends!!!! Free!!!"` → description retains `!!!!`. `"Bring a costume 👻 and candy 🍬."` → `"Bring a costume and candy ."` (a space before the period remains after emoji removal). No spelling or grammar correction is performed anywhere.

**Expected:** the policy asks for corrected spelling/grammar, no excessive punctuation, and removal of social-media chatter (`event-format-rules.md:9,40-41`). Phase 1 intentionally does not spell-check; that should be an explicit, documented limitation rather than an accidental gap.

**Why it matters:** Public descriptions may contain shouting punctuation and chatter. This is conservative (no facts changed) but does not meet the presentation policy.

**Smallest fix:** Apply `collapsePunctuation` to the description (not to URLs), and document spelling/grammar and chatter removal as deferred to a later phase or a human reviewer.

**Regression test:** the input above, asserting `!!!!` is collapsed if the fix is accepted.

---

### P3-5 — Notice submissions receive irrelevant location/cost flags

**Severity:** P3 · **Confidence:** High (reproduced)  
**Location:** `rules.ts:462` (`missing_location`), `:480-481` (`cost_unclear`)

**Input:** a `Community Notices` road-closure notice with no location and no cost.  
**Actual:** flags `missing_location`, `cost_unclear` (plus `safety_sensitive`).  
**Expected:** a notice legitimately may have neither; flagging both trains reviewers to ignore flags.

**Why it matters:** Flag fatigue reduces the value of the review routing. The policy lists these as example flags for missing facts, so this is a judgment call, but the notice workflow is explicitly different.

**Smallest fix:** Suppress `missing_location` and `cost_unclear` for `Community Notices`, or add a documented `not_applicable` handling rule.

**Regression test:** notice input, asserting only `safety_sensitive` (or the agreed set).

---

### P3-6 — Orphan `endAt` and all-day-without-date states are accepted

**Severity:** P3 · **Confidence:** High (reproduced)  
**Location:** `rules.ts:441-449`; `types.ts` cross-field checks

**Input A:** `startAt: null, endAt: "2026-11-07T19:00:00.000Z"` → draft keeps `endAt`, flags only `missing_date`.  
**Input B:** `startAt: null, allDay: true` → draft `allDay: true`, `startAt: null`.

**Expected:** either drop the orphan end and the meaningless all-day flag, or flag them explicitly. The validator allows both, so a future provider can produce them too.

**Why it matters:** A draft with an end but no start, or “all-day” with no date, is confusing to review and may map poorly to the approval form (which requires a start).

**Smallest fix:** Null `endAt` when `startAt` is null and add a specific flag, or keep the values and document them; add the same cross-field rule to `validateDraft`.

**Regression test:** both inputs above.

---

### P3-7 — Source URLs can contain control characters

**Severity:** P3 · **Confidence:** High (reproduced)  
**Location:** `types.ts:285-298`; `rules.ts:472-477`

**Input:** `sourceUrl: "https://exa\nmple.com/event"`.  
**Actual:** `draft.sourceUrl` is the raw string with the newline; `isValidHttpUrl` returns true because `new URL` strips the newline.  
**Expected:** reject control characters before parsing.

**Why it matters:** The stored/displayed URL is not the URL that was validated. The admin UI's `<input type="url">` may normalize it differently. Localhost sources are also accepted (same helper).

**Smallest fix:** `if (/[\u0000-\u001F\u007F]/.test(value)) return false;` and reject loopback/private hosts (or flag them).

**Regression test:** the input above must not produce a valid `sourceUrl`.

---

### P3-8 — The “never throws” boundary does not cover hostile objects

**Severity:** P3 · **Confidence:** High (reproduced)  
**Location:** `index.ts:61-62` (version read outside `try`), `:76` (`parseNormalizerInput` outside `try`), `:98-110` (`validateDraft` outside `try`)

**Input:** a provider whose `version` getter throws; a provider that returns `new Proxy({}, { getPrototypeOf() { throw new Error("boom"); } })` (no `get` trap); or an input `Proxy`.  
**Actual:** `runNormalization` rejects with the thrown error instead of returning a safe result (verified: `provider proxy threw: boom`, `rejected: proto boom`, `input proxy threw: boom`).

**Expected:** the documented boundary says normalisation never throws across the interface. JSON input cannot be a Proxy, so this is mainly a guarantee/documentation issue; providers are internal code, not untrusted data.

**Smallest fix:** Wrap the whole body (including version access, input parsing, and validation) in one `try/catch` that returns a fixed failure; or narrow the documented guarantee to “JSON-shaped input and well-behaved providers”.

**Regression test:** a provider returning the `getPrototypeOf`-only Proxy above → resolved `status: "failed"`, not a rejected promise.

---

### P3-9 — Tooling: tests are outside the typecheck project; directory test discovery fails

**Severity:** P3 · **Confidence:** High (reproduced)  
**Location:** `artifacts/api-server/tsconfig.json:4,6` (`allowImportingTsExtensions`, `noEmit`), `:12` (`include: ["src"]`); `package.json:11` (`node --test tests/*.test.ts`)

**Facts:**

- Tests live in `artifacts/api-server/tests/`, outside `src`, so `tsc -p tsconfig.json --noEmit` does not typecheck them. They were typechecked separately in this review with equivalent options (exit 0).
- `node --test tests/` fails on Node 22.22.3 with `Cannot find module .../tests`; the shipped script uses a shell glob and works. Node 22.22 also accepts a quoted glob (`node --test "tests/*.test.ts"`), which would be more portable. The test-file header (`tests/normalizer.test.ts:4`) still documents `node --test tests/`, the failing form.
- `noEmit: true` is required by `allowImportingTsExtensions`; the project build is esbuild, so this is coherent, but it changes what `tsc -p tsconfig.json` does for anyone who runs it without `--noEmit`.
- The `.ts` import specifiers are a new convention for this package; every new file in the module must keep them or Node test execution breaks.

**Why it matters:** A future contributor can add a test with a type error that CI never sees, or add an extensionless internal import that passes tsc/esbuild but breaks `node --test`.

**Smallest fix:** Add `tests` to a dedicated `tsconfig.test.json` (or a second `include`) used by a `typecheck:test` script; quote the test glob; document the `.ts`-specifier and Node ≥22.18 requirements.

**Regression test/CI:** run both `pnpm --filter @workspace/api-server test` and the test typecheck.

---

### P3-10 — The exported provider allows bypassing `validateDraft`

**Severity:** P3 · **Confidence:** High (verified by reading)  
**Location:** `index.ts:30` (`export { rulesNormalizer }`), `rules.ts:538-547`

**Fact:** `rulesNormalizer.normalize(parsedInput, context)` is public and returns a `NormalizedEventDraft` without passing through `validateDraft`. A caller must parse the input first, but validation is then skipped.

**Why it matters:** The architecture says every draft must pass validation before storage/display. The primary entry points (`normalizeEvent`, `runNormalization`) do validate; the exported provider is a secondary path that can be misused.

**Smallest fix:** Keep the provider internal (do not export it), or export a `normalizeDraft` helper that validates; document that direct provider use is unsupported.

**Regression test:** none required if the provider is no longer exported; otherwise assert the documented path.

---

### P3-11 — The deterministic provider can emit a draft that fails its own validator

**Severity:** P3 · **Confidence:** High (reproduced)  
**Location:** `rules.ts:356-376` (`extractContact`; `contactMax` checked only when adding the phone, line 372), `types.ts:559-566`

**Input:** `details = "Contact " + "a".repeat(200) + "@example.org for details."`  
**Actual:** `status: "failed"`, `error.code === "invalid_provider_output"`, `draft: null` — the provider produced a contact longer than the 200-character limit that `validateDraft` enforces.  
**Expected:** the provider caps or drops the contact and returns a usable draft with a flag; a pathological but valid input should not lose the whole draft.

**Why it matters:** The interface promises the provider always emits a contract-valid draft; the wrapper turns a self-inconsistency into a generic failure. The failure is safe (no invalid draft is returned) and the input is unusual, hence P3 rather than P2.

**Smallest fix:** Check the email alone against `LIMITS.contactMax` before joining; if it exceeds the cap, do not promote it and add `contact_not_public` (or truncate at a safe boundary). The phone join already does this.

**Regression test:** the input above → `status !== "failed"`, `draft !== null`, `contact` null or ≤200, and a flag explains why.

---

### P3-12 — “50/50” is treated as an unresolved date

**Severity:** P3 · **Confidence:** High (reproduced)  
**Location:** `rules.ts:109-116` (`DATE_EXPRESSION_PATTERN`, bare `\d{1,2}/\d{1,2}` alternative)

**Input:** `details = "50/50 draw at halftime. Everyone welcome."`, no `startAt`.  
**Actual:** flags `missing_date`, `cost_unclear`, and `date_expression_unresolved`.  
**Expected:** no date flag; a ratio is not a date.

**Why it matters:** False flags train reviewers to ignore the flag list, which is the only safety surface Phase 1 adds. It also makes the `unresolvedQuestions` list noisy.

**Smallest fix:** Remove the bare `\d{1,2}/\d{1,2}` alternative or require a 4-digit year or a date-context word (`on|date|when`) around it; keep `\d{4}-\d{2}-\d{2}` and month-name forms.

**Regression test:** the input above → `date_expression_unresolved` absent; a real `10/24/2026` → present.

---

## 4. Specification compliance matrix

Status: **Yes** = implemented and exercised; **Partial** = implemented with a defect or narrow coverage; **No** = absent; **Deferred** = explicitly outside Phase 1 scope; **N/A** = not applicable to a pure normalizer.

| Rule (source) | Status | Evidence / note |
|---|---|---|
| Fix presentation without changing facts (`rules:9`) | Partial | Cost/contact/title-casing findings P1-1…3, P2-4 |
| Correct spelling, grammar, punctuation (`rules:9`) | No | No spell/grammar correction; punctuation only in title/summary/location/organizer (P3-4) |
| Extract details into structured fields (`rules:9`) | Partial | Structured fields accepted; dates are validated but never extracted (deferred) |
| Never invent details or silently resolve uncertainty (`rules:9`) | Partial | Mostly conservative; cost/category extraction can invent (P1-1/P1-2); date conflicts ignored (P2-3) |
| Preserve raw submission and source separately (`rules:9`) | Deferred | Module returns a draft only; persistence is Phase 2 |
| Title short, specific (`rules:13`) | Partial | Length capped; casing can mangle acronyms (P2-4); punctuation (P3-1) |
| Category one of five (`rules:14`) | Yes | `EVENT_CATEGORIES`; supplied valid category wins |
| Date/time local Pacific (`rules:15`) | Deferred | No text date parsing; structured timestamps are absolute |
| Location proper venue (`rules:16`) | Partial | Cleaned; no verification; missing flag noisy for notices (P3-5) |
| Summary one sentence (`rules:17`) | Yes | First sentence; abbreviation cuts (P3-3) |
| Description details/conditions (`rules:18`) | Yes | Body text preserved verbatim (after cleanup) |
| Cost exact; Free only explicit (`rules:19`) | No | P1-1/P1-2 reproduced |
| Organizer/contact only public (`rules:20`) | Partial | P1-3: first-person and frame-bleed cases |
| Registration verified/supplied (`rules:21`) | Partial | P2-1/P2-2 |
| Source/provenance (`rules:22`) | Partial | URL validated; no attachment/provenance data in the draft |
| Approved categories only (`rules:34`) | Yes | Invalid supplied category never echoed |
| Plain style; no all caps/emoji (`rules:40`) | Partial | Emoji stripped; mixed-case shouting and description punctuation remain |
| Remove repetition/social chatter (`rules:41`) | No | Not implemented; conservative |
| Preserve uncertainty (`rules:42`) | Yes | Description verbatim; summary may omit later conditions by design |
| Interpret dates in `America/Vancouver` (`rules:46`) | Deferred | No text dates; no timezone conversion of naive input (input requires explicit offset) |
| Display dates unambiguously (`rules:47`) | Deferred | Formatting is a UI concern |
| Store ISO timestamps with timezone (`rules:48`) | Yes | Input canonicalised to UTC `Z`; validator defect P1-4 |
| Relative dates need reference else flag (`rules:49`) | Yes | `relative_date_unresolved`, never resolved |
| Weekday/date conflict → flag (`rules:50`) | No | P2-3; no text-date comparison |
| No year inference (`rules:51`) | Yes | No year logic at all |
| Start/end separate; no invented end/all-day (`rules:52-53`) | Yes | `allDay` echoed; no end invention |
| No recurring expansion (`rules:54`) | Yes | Not implemented |
| End before start = validation failure requiring review (`rules:55`) | Partial | `needs_review` + retained interval; the validator rejects an unflagged invalid interval but accepts one that carries `end_before_start` (see §3 note) |
| Unknown is not “free” (`rules:59`) | Partial | Unknown cost is null + flag; false “Free” cases P1-1 |
| Never infer venue/address/organizer/phone/age/etc. (`rules:60`) | Partial | No venue/age inference; phone/email promotion P1-3 |
| Preserve source URLs / never fabricate links (`rules:62`) | Partial | Source validated; registration misattribution P2-1 |
| Treat text as untrusted, ignore instructions (`rules:63`) | Yes | No execution; `instruction_like_text` flag |
| No “official/verified” claims (`rules:64`) | Yes | No such fields or claims |
| Flag personal contact (`rules:65`) | Partial | P1-3 |
| Human approval when missing/ambiguous/safety-sensitive (`rules:69-76`) | Yes | Flags produce `needs_review`; publication is outside the module |
| Duplicate possible → flag (`rules:71`) | Partial | Only if caller passes `duplicatePotential`; no detection |
| Source unverified → flag (`rules:72`) | No | No verification capability; not flagged |
| Output contract fields (`rules:81-90`) | Yes | All 17 fields defined and validated |
| Stable codes + explanations (`rules:85`) | Yes | 18 closed codes, fixed messages from the rules provider |
| `changedFields` (`rules:86`) | Partial | Under-reports whitespace/derived fields (P3-2) |
| `unresolvedQuestions` (`rules:87`) | Yes | Derived from flags, capped |
| Exact schema enforced by code (`rules:89`) | Partial | Strict validator, but P1-4/P2-7/P2-8 gaps; Zod not used (documented deviation) |
| Independently validate required fields/categories/timestamps/end-after-start/URLs/lengths (`rules:93`) | Partial | P1-4 (impossible timestamps); end-before-start preserved and flagged, not rejected (see §3 note) |
| Duplicates where practical (`rules:93`) | No | Caller-supplied only |
| Reject malformed output (`rules:93`) | Partial | Ordinary malformed output rejected; impossible dates pass |
| Bound sizes; timeouts (`rules:95`) | Partial | Size bounds yes; no timeout (no I/O in Phase 1) |
| Never drop a submission / publish unvalidated output (`rules:95`) | Yes | Module never persists or publishes |
| No logging of keys/tokens/emails (`rules:95`) | Yes | No logging at all |
| No paid provider by default (`rules:95`) | Yes | Deterministic only |
| Link rules from prompt/tests (`rules:114`) | No | Neither the module nor the tests reference `event-format-rules.md` |
| Store draft and flags separately (`rules:115`) | Deferred | Persistence is Phase 2; the module returns an in-memory draft |
| Validate model output before admin UI (`rules:116`) | Partial | `runNormalization` validates; the admin UI is not wired yet |
| Test misspellings, OCR, weekday conflicts, recurring events, timeout (`rules:118`) | No | No such tests; see §5 |

---

## 5. Missing regression tests

The 29 existing tests assert real values and cover the happy path well. The following cases are absent and would have caught confirmed defects. Each is written against the existing helpers (`baseInput`, `normalize`, `codes`).

1. **Cost — hyphenated free:** `"This is a smoke-free event. Tickets are $10."` → `cost !== "Free"`.
2. **Cost — partial free:** `"Admission is $10; free for children under 5."` → `cost !== "Free"`.
3. **Cost — fundraising target:** `"We hope to raise $5000 for the playground."` → `cost === null` + `cost_unclear`.
4. **Cost — discount:** `"Bring this coupon for $15 off your ticket."` → `cost === null`.
5. **Cost — false negative:** `"The event is free for everyone."` → `cost === "Free"` (currently null).
6. **Contact — first person:** `"Call me at 250-555-1234 to RSVP."` → `contact === null` + `contact_not_public`.
7. **Contact — frame bleed:** `"Contact Jane at jane@example.org. My cell is 250-555-1234."` → contact contains only the public email; personal number flagged.
8. **Validator — impossible date:** `validateDraft({ ...draft, startAt: "2026-02-30T10:00:00.000Z", endAt: null }).ok === false` (null the end so the interval rule cannot mask the result).
9. **Validator — out-of-range year:** `0001-01-01` and `9999-12-31` rejected, again with `endAt: null`.
10. **Validator — PII flag message:** provider returns a flag message containing an email/phone → result must not contain it.
11. **Validator — bogus title/cost/contact/URL:** `title: "123"`, `"not a price"`, `"ask at the desk"`, `"http://localhost:1106/internal"`, `"https://exa\nmple.com"` → rejected.
12. **Abort signal:** already-aborted signal → documented failure status, no draft.
13. **Registration — next line:** `"Register:\nhttps://example.org/rsvp"` → URL extracted.
14. **Registration — info link:** `"Register at the hall. More info: https://example.org/info"` → `registrationUrl === null`.
15. **Title — brand/acronym:** `"LEGO BUILDERS CLUB"`, `"COVID-19 UPDATE"`, `"2SLGBTQ+ PRIDE NIGHT"`, `"A&B CRAFT SALE"` retain their casing.
16. **Title — punctuation:** `"!!! KIDS FAIR"` has no leading `!`.
17. **Summary — abbreviation:** `"Doors open at 6 p.m. and close at 9 p.m."` → full sentence.
18. **Date conflict:** structured `2026-11-07` plus text `"October 24"` → a date flag.
19. **Orphan end / all-day:** `startAt: null, endAt: ...` and `allDay: true, startAt: null` → documented behavior.
20. **Source URL control character:** newline inside the URL → rejected.
21. **Duplicate input flag:** already covered; add a test that an integration-style object with `duplicatePotential: true` yields the flag and question.
22. **Empty submission:** `{}` → `missing_title`, `missing_date`, `missing_location`, `cost_unclear`; no crash (documents the current draft).
23. **Integration shape:** Date objects for `startAt`/`endAt`, `followUpEmail` present, `duplicatePotential: false` → draft produced; `followUpEmail` absent everywhere (partially covered, but make it explicit).
24. **Changed fields whitespace:** `title: "  Spring Fair  "` → `changedFields` includes `title` or the contract documents the trim.
25. **Cost — free sub-offers:** `"Free parking for families at the arena."` and `"Tickets are $10; free for students."` → `cost !== "Free"`.
26. **Provider self-inconsistency:** a >200-character framed email → the provider must still return a valid draft (currently `failed invalid_provider_output`).
27. **Date — ratio false positive:** `"50/50 draw at halftime."` (no `startAt`) → `date_expression_unresolved` absent.
28. **Status meaning:** the smoke-free input → `status` is `normalized` today; the test should assert the chosen status semantics and that approval is still required.
29. **Test command:** CI should run the same command the file header documents; the header currently says `node --test tests/`, which fails.
30. **Structured date + text date:** `startAt: "2026-11-07T17:00:00.000Z"` with details `"Join us October 24"` → a date-conflict flag (same case as 18, made explicit for the structured path).

---

## 6. Prioritized minimal-fix plan

No P0 fixes are required.

### Batch 1 — P1, required before integration (small, localized)

1. `extractCost`: standalone-free guard (`(?<![-\w])`), reject free sub-offers (`parking`, `for kids/students/...`), and require a price context; if free and a price coexist, prefer the price or flag. (`rules.ts:137-143, 335-348`)
2. `extractContact`: first-person guard and per-match framing; do not join a personal phone into a public contact; enforce `contactMax` for the email alone. (`rules.ts:350-382`)
3. `isCanonicalIsoTimestamp`: delegate to `canonicalIsoTimestamp(value) === value` (round-trip, 1900–2200). (`types.ts:269-271`)
4. Add the regression tests 1–4, 6–9, 25–26 above.

### Batch 2 — P2, required before the admin UI shows drafts as reviewed

5. Registration URL: immediate-frame requirement and cross-line detection. (`rules.ts:384-401`)
6. Date conflict: always flag unparsed date expressions. (`rules.ts:488-492`)
7. Flag messages: canonical messages enforced by the validator. (`types.ts:633-645`)
8. `producedAt`: rename or document; decide before persistence. (`types.ts:200-204`)
9. Abort signal: check before work and document provider obligations. (`index.ts:81-86`)
10. Acronym/brand casing: preserve digits/`&`/`+` tokens and expand the policy, or flag all-caps titles. (`text.ts:62-65, 176-205`)
11. `status`: rename `normalized` to `no_flags` or document that it is advisory only; never add an approval-like status. (`index.ts:112`, `types.ts:180`)
12. Add regression tests 10–16, 18, 27, 30.

### Batch 3 — P3, before merge or in a follow-up

13. Title punctuation and mixed-case shouting; `changedFields` whitespace; summary abbreviations; description punctuation (including the emoji-removal space); notice flag noise; orphan end/all-day; URL control characters; no-throw boundary; `50/50` date false positive.
14. Tooling: test typecheck config, quoted glob, documented Node/`.ts`-specifier requirements; fix the test-file header command; consider making the provider non-exported.
15. Add tests 17–24, 28–29.

### Re-run gate

- `npm test` → all tests pass.
- Out-of-tree `tsc` over module + tests → exit 0.
- `esbuild` bundle of `index.ts` → exit 0.
- Manual re-run of the P1 probes (cost, contact, validator) with corrected expectations.

---

## 7. Integration readiness

### 7.1 Input shape vs the submission route

Verified against `artifacts/api-server/src/routes/submissions.ts:123-175`, `lib/api-spec/openapi.yaml:712-733`, `lib/api-zod/src/generated/api.ts:142`, and `lib/db/src/schema/community.ts:54-79`.

| Route / request field | Normalizer input | Status |
|---|---|---|
| `title` | `title` | Matches (route trims; `title` may be absent) |
| `category` | `category` | Matches (OpenAPI enum = `EVENT_CATEGORIES`) |
| `startAt` (zod `Date`) | `startAt` | Matches; parser accepts `Date` and canonicalises |
| `endAt` (zod `Date`) | `endAt` | Matches |
| `allDay` (boolean, default false) | `allDay` | Matches |
| `location` | `location` | Matches |
| `details` (≤5000) | `details` | Matches |
| `sourceUrl` | `sourceUrl` | Matches (route already restricts to http/https) |
| `organizer` | `organizer` | Matches |
| `followUpEmail` | — | Deliberately ignored (verified: never appears in the result) |
| `attachmentClaims` | — | Not accepted; OCR text must be passed as `rawText` when available |
| `website` (honeypot) | — | Ignored |
| `duplicatePotential` | `duplicatePotential` | **Not part of `SubmissionInput`**, but the route computes it (`submissions.ts:175`) and persists it on the submission row (`submissions.ts:195`, column `community.ts:70`). The integration must read it from the row or pass it explicitly; otherwise the duplicate flag is silently absent. |
| `referenceTime` | options | **Not part of the submission**; must be the submission's `createdAt`. Missing → `invalid_input`, no draft. |

### 7.2 Behavioural integration notes

- **Publication gate unchanged.** `normalized` means “valid draft with no flags”, not “approved”. Phase 2 must still route every draft to admin review; the existing approval endpoint remains the only publication path.
- **Admin prefill today.** `SubmissionApprovalEditor` (`App.tsx:414-426`) prefills title, category, dates, all-day, location, organizer, source URL, and description; it does **not** prefill `summary`, `contact`, `cost`, or `registrationUrl` today. That limits the immediate blast radius of P1-1/P1-2/P1-3 to what Phase 2 adds. If Phase 2 prefills those fields (the audit's plan), the P1s become directly actionable by an admin clicking through.
- **Private data in the description.** The description preserves the submitted text, including any email/phone that was *not* promoted to `contact`. The `contact_not_public` flag warns, but the text is still there. Phase 2 should either redact/warn at review time or keep the description read-only until the admin confirms.
- **Duplicate detection.** The module only reflects `duplicatePotential`; it does not check the database. The route's `maybeDuplicate` (events only, published/cancelled) must be the source of truth.
- **The interval check is not re-applied at approval.** `POST /api/admin/submissions/:id/approve` (`submissions.ts:294-354`) does not compare `endAt` to `startAt`; only the public intake does (`:168-173`). The normalizer's `end_before_start` flag cannot protect an admin edit. This is outside the Phase 1 change scope, but Phase 2/3 should add the same check at approval.
- **Raw source.** The draft has no provenance field; the submission row and uploaded attachments remain the raw record. That matches the audit, but the normalized draft must be stored separately (Phase 2) rather than overwriting submission columns.
- **No OCR.** `rawText` is supported but nothing produces it yet; the module correctly returns missing-title/date/location flags for attachment-only submissions.
- **Zod deviation.** `api-server` has no direct `zod` dependency (verified in `package.json`: only the `@workspace/api-zod` workspace package); the strict validator is an intentional, documented deviation. No lockfile change is needed.

### 7.3 Contract surface that Phase 2 must not misread

- `status: "normalized"` with zero flags still requires human approval.
- `producedAt` is the echoed reference time, not the normalization time.
- `changedFields` is a subset of fields the normalizer altered; it does not list extracted values (`cost`, `contact`, `tags`, `registrationUrl`) or `description`.
- `reviewFlags` messages from a future provider are not yet constrained (P2-7).

---

## 8. Commands actually run and results

All commands were run from the repository root unless noted, on Node `v22.22.3`. No repository dependency was installed during this review. Read-only inspection used `sed`, `grep`, and `nl`; only the verification runs below are listed.

| # | Command | Exact result |
|---|---|---|
| 1 | `node --version` | `v22.22.3` |
| 2 | `cd artifacts/api-server && node --test tests/*.test.ts` | `# tests 29`, `# pass 29`, `# fail 0`, `duration_ms 218.499715`, exit 0 |
| 3 | `cd artifacts/api-server && npm test` | `# tests 29`, `# pass 29`, `# fail 0`, `duration_ms 152.811157`, exit 0 |
| 4 | `cd artifacts/api-server && node --test tests/` | **fails**: `Error: Cannot find module '/home/user/TR-Calender/artifacts/api-server/tests'` (this is the command the test file header documents) |
| 5 | `/tmp/tscprobe/node_modules/.bin/tsc -p /tmp/tscprobe/tsconfig.repo.json` | exit 0 (TypeScript `5.9.3`; repo `tsconfig.base.json` options + `allowImportingTsExtensions`/`noEmit`; includes the normalizer modules **and** `tests/**/*.ts`) |
| 6 | `/tmp/tscprobe/node_modules/.bin/esbuild .../src/lib/normalizer/index.ts --bundle --format=esm --platform=node --outfile=/tmp/tscprobe/normalizer-review.mjs` | exit 0 (esbuild `0.28.2`) |
| 7 | import the bundle and call `normalizeEvent({title:"Test Event", details:"Join us. Admission is free."}, …)` | `needs_review Free` (string output) |
| 8 | `node /tmp/review-probe.ts` | Reproduced: smoke-free→`Free`/`normalized`; `raise $5000`→`$5000`/`normalized`; partial-free→`Free`; `Call me`→`contact:"250-555-1234"` with only `cost_unclear`; frame-bleed→`"jane@example.org \| 250-555-1234"` with only `cost_unclear`; info link→`registrationUrl:"https://example.org/info"`; `LEGO`→`Lego`; `2SLGBTQ+`→`2Slgbtq+`; `!!! KIDS FAIR`→`! Kids Fair`; `KIDS Halloween PARTY` unchanged; summary cut at `p.m.`; `!!!!` retained in description; `C#basics`→tag `basics`; `allDay` without date allowed; `endAt` without `startAt` allowed; validator accepts impossible dates, `title:"123"`, bogus cost/contact, localhost and newline URLs; aborted signal ignored; `producedAt` echoes 1999; newline `sourceUrl` retained |
| 9 | `node /tmp/review-probe2.ts` | Reproduced: `Free parking for families`→`Free`/`normalized`; `Tickets are $10; free for students`→`Free`/`normalized`; notice without location→`missing_location`,`cost_unclear`,`safety_sensitive`; 200-char email→`failed invalid_provider_output`; `B.C.`/`U.S.` summaries; emoji removal leaves `candy .`; structured `startAt` + text `October 24`→no date flag; `localhost` source accepted; `www.` registration flagged invalid; `Register:` + next-line URL→no registration URL |
| 10 | `node /tmp/review-probe3.ts` | `provider impossible date => normalized 2026-02-30T10:00:00.000Z null`; `provider PII flag => needs_review [{"code":"missing_location","message":"call jane at 250-555-1234"}]`; `provider arbitrary cost => normalized $5000` |
| 11 | `node --input-type=module -e '…'` (custom provider, impossible date) | `normalized "2026-02-30T10:00:00.000Z" null` |
| 12 | `node --input-type=module -e '…'` (50/50) | flags `["missing_date","cost_unclear","date_expression_unresolved"]` |
| 13 | `git status --porcelain` | `?? docs/phase-1-normalizer-review.md` (only the report; no application file changed) |
| 14 | `git log --oneline -3` | `8215414`, `7ad6995`, `a8e42bc` |

Selected probe output (verbatim, from row 8):

```
smoke-free | normalized | cost: "Free" | contact: null | reg: null | flags: 
fundraise | normalized | cost: "$5000" | contact: null | reg: null | flags: 
partial-free | normalized | cost: "Free" | contact: null | reg: null | flags: 
call-me | needs_review | cost: null | contact: "250-555-1234" | reg: null | flags: cost_unclear
frame-bleed | needs_review | cost: null | contact: "jane@example.org | 250-555-1234" | reg: null | flags: cost_unclear
reg-info | needs_review | cost: null | contact: null | reg: "https://example.org/info" | flags: cost_unclear
```

A separate validator run with `endAt: null` returned `ok === true` for `2026-02-30T10:00:00.000Z`, `0001-01-01T00:00:00.000Z`, and `9999-12-31T23:59:59.000Z`; with a 2026 `endAt`, `9999` is rejected only because the interval check fires.

**Not run:** `pnpm install` (so no workspace-wide `pnpm typecheck`/`pnpm build`), any database command, any browser/UI test, and Node 24 itself. `pnpm` is not installed in this environment and the workspace has no `node_modules`; installing dependencies was prohibited. `npm test` inside `artifacts/api-server` runs the package's `node --test` script without a workspace install.

---

## 9. Remaining uncertainties and limitations

1. **Node 24 was not exercised directly.** The Replit module is `nodejs-24` (`.replit:1`), but the sandbox runs Node 22.22.3. Native TypeScript stripping is stable in both; the tests passed on 22.22.3. The exact Node 24 behaviour of `node --test "tests/*.test.ts"` was not observed.
2. **Full workspace typecheck/build was not run.** Only the module and tests were typechecked, with the repository's base compiler options, and the module was bundled with the repo's pinned esbuild version.
3. **No database was available.** The behaviour of Postgres with an impossible date, and the eventual `normalized_draft` persistence, were not tested.
4. **Phase 2 UI behaviour is a plan, not code.** The P1 severity of cost/contact assumes the draft will prefill or be prominently shown in the approval editor, as the audit proposes. The current editor (`App.tsx:414-426`) does not prefill `cost`, `contact`, `registrationUrl`, or `summary`; if Phase 2 only displays flags without prefilling, those findings drop to P2.
5. **“Smoke-free” and “fundraising target” are representative, not exhaustive.** Other phrasings (`gluten-free`, `sugar-free`, `free for members`, `50/50 tickets $5`, `value $200`) are likely to behave similarly; the fix should be pattern-based, not string-specific.
6. **Severity of P2-4 (acronym casing) is a judgment call.** `changedFields` does record that the title changed, so an attentive reviewer can catch it; no automatic publication occurs.
7. **The Proxy no-throw issue (P3-8) is not reachable through Express JSON.** It matters only for the stated “never throws” guarantee and for internal misuse; it is not a public-input vulnerability.
8. **The restored `docs/event-format-rules.md` is byte-identical to `origin/main`** (blob `81c5047`); this review treated it as authoritative.
9. **No finding was fabricated to fill a severity level.** Findings labelled “High (reproduced)” were observed in probes; none are theoretical.
10. **The contact P1 is policy-dependent.** “Call me”/“Contact me” are unambiguously first-person, but whether a phone on a public flyer is “clearly intended for public event use” (`event-format-rules.md:65`) is an editorial call. The behaviour is verified; the severity assumes a personal number should not be promoted without a flag.
11. **Date-only input is coerced upstream.** The route's zod schema uses `z.coerce.date()` (`api.ts:142`), so a date-only JSON value becomes a `Date` at midnight before the normalizer sees it; the normalizer's “reject date-only” rule only applies when it receives the raw string. The normalizer cannot recover the lost “date-only” fact from a `Date`.
12. **P1-4 is latent, not live.** The shipped rules provider cannot emit an impossible date; the defect matters because `validateDraft` is the documented boundary for future providers and for drafts read back from storage. It is not currently reachable through the submission route.
13. **P3-11 is pathological.** A framed email longer than 200 characters is not realistic flyer content; the finding is recorded for contract consistency, not because it is expected in production.

---

## 10. Recommended next step

Fix the four P1 findings and add tests 1–4, 6–9, and 25–26 from §5, then re-run the gate in §6. After that, the module is a suitable basis for Phase 2 integration, with P2-1/P2-3/P2-6/P2-7 addressed before the admin UI treats a draft as checked. No Phase 2 work should begin until this review has been evaluated and the fixes approved.
