# First ingestion source — Visit Tumbler Ridge

**Branch:** `arena/ba533186-tr-calender`
**Source:** `https://www.visittumblerridge.ca/events`
**State:** implemented and fixture-tested. **Not verified against the live
page.** This sandbox has no outbound internet access; no request was made to
`visittumblerridge.ca`, and no real listing was imported.

---

## 1. What runs

```
node dist/ingest.mjs                 fetch → parse → validate → write drafts
node dist/ingest.mjs --dry-run       fetch → parse → validate → print, no writes
node dist/ingest.mjs --inspect       fetch → print structure counts only
```

`artifacts/api-server/src/ingest.ts` is the polling entry point, built as a
second esbuild entry (`dist/ingest.mjs`). `--inspect` and `--dry-run` never
import `@workspace/db`, so they work without `DATABASE_URL` and are the
supported way to check a live page before letting it write.

Module layout:

| File | Responsibility |
| --- | --- |
| `src/ingestion/http.ts` | Retrieval only: timeout, size limit, content-type gate, typed `SourceFetchError`. `fetch` is injected. |
| `src/ingestion/html.ts` | Anchor, JSON-LD, `<link>` and entity helpers. No class names, ids or component assumptions. |
| `src/ingestion/dateParsing.ts` | iCalendar `DATE`/`DATE-TIME` and ISO 8601 parsing, including date-only values. |
| `src/ingestion/time.ts` | Wall-clock → UTC using `Intl` and `America/Vancouver`; no bundled tz database. |
| `src/ingestion/ics.ts` | Minimal iCalendar reader (unfolding, escapes, `TZID`, `UID`, `RRULE` detection). |
| `src/ingestion/visitTumblerRidge.ts` | The adapter: fetch the listing page, extract candidates, resolve per-event `.ics` files. |
| `src/ingestion/mapping.ts` | Validate a listing into the existing event model; compute the content hash. |
| `src/ingestion/dedupe.ts` | Within-page duplicate removal. |
| `src/ingestion/run.ts` | The pipeline and its failure policy. |
| `src/ingestion/cli.ts` | Argument parsing, configuration validation and exit codes. Pure: no I/O. |
| `src/ingestion/store.ts` | Persistence interface. |
| `src/ingestion/drizzleStore.ts` | Drizzle implementation (not test-covered; no database here). |

## 2. Verified versus assumed

**Verified by the architect and used as input:**

- The page lists events with title, date and start/end times where available,
  location and description.
- It links to event detail pages.
- Individual events have Google Calendar and ICS links.
- No complete calendar feed is established.

**Assumed (fixture-driven, still to be confirmed live):**

1. That the page may carry schema.org `Event` JSON-LD. If present, it is the
   best source of full descriptions and canonical detail URLs.
2. That the Google Calendar links use the standard
   `calendar.google.com/calendar/render?action=TEMPLATE&text=&dates=&…` format.
   The adapter only accepts that shape; a bespoke link is ignored.
3. That `.ics` links are per-event files. The adapter accepts `.ics` served by
   the source's own host, or a Google-hosted `.ics` carrying an `eid`. A
   shared export (`…/public/basic.ics` without `eid`) is rejected.
4. That a per-event `.ics` contains exactly one `VEVENT`. If it contains more,
   the item is held with `ics_multiple_events` instead of partially imported.

Nothing in the adapter reads a class name, an id, a CSS selector or a
framework-specific attribute, because none of that was available to inspect.

## 3. Import and review behaviour

- Every new import is written with `status = 'draft'`. **Ingestion cannot
  publish.** An administrator publishes through the existing Events tab, which
  is the existing review and publication path.
- A listing with no readable title or start date is **held**: no event is
  written. Its parsed payload, reason code and source URL go to
  `community_ingestion_items` with `outcome = 'held'`, so it can be reviewed
  and diagnosed.
- A recurring event (`RRULE`), a cancelled event, a multi-event `.ics`, an
  unknown `TZID` and an unreadable date are all held, never expanded or guessed.
- Imported events use `category = 'Community Events'` and no summary, tags,
  cost, contact, registration URL or organizer. Those stay administrator-owned.
- An event that disappears from the source is **not** deleted or unpublished.
  Ingestion has no destructive path; an administrator removes or cancels it.

### Deduplication and updates

- Primary key: `(source_key, external_id)` — `external_id` is the iCalendar
  `UID`, the structured-data `@id`/`url`, or the canonical URL.
- If the identifier is not found, one secondary lookup is allowed: the same
  source, the **same exact title** and the **same exact start instant**. This
  handles a regenerated link or changed UID. Similar titles alone never match.
- If the stored content hash equals the new one, the event is untouched except
  for `last_verified_at` (and `updated_at` deliberately does not change).
- If it differs, only the source-owned fields are written: title, description,
  start, end, all-day, location, source URL, content hash, `last_verified_at`
  and — when adopted — the identifier. Status, category, summary, tags, cost,
  contact, registration and organizer are preserved.
- **Known limitation:** a Google Calendar template URL encodes the event
  content, so a changed title or time produces a new identifier. Such a listing
  is imported as a new draft instead of being matched to the old one. Matching
  on time alone was rejected as unsafe. Events backed by an `.ics` `UID` update
  in place correctly; that is the path the live page is expected to offer.

## 4. Source health

`community_ingestion_sources` holds one row per source:

| Column | Meaning |
| --- | --- |
| `status` | `idle` / `ok` / `partial` / `failed` |
| `last_attempt_at` | start of the most recent run |
| `last_success_at` | when a page was successfully read and validated |
| `last_failure_at`, `last_error_code` | the most recent failure |
| `consecutive_failures` | reset on success, incremented on failure |
| `last_run_summary` | counts and held reasons for the last run |

A failed fetch or parse writes **only** this table. Imported events keep their
content and their `last_verified_at`, so old data cannot look freshly checked.

`partial` means the run completed but at least one listing was held or one row
failed; `failed` means the source could not be read at all.

## 5. Running it, and what the exit codes mean

```bash
pnpm --filter @workspace/api-server run build
node artifacts/api-server/dist/ingest.mjs --help
```

| Exit code | Meaning | What to do |
| --- | --- | --- |
| `0` | Completed; at least one listing was mapped, or at least one event was imported / updated / re-verified. | Read the counts. |
| `1` | The source could not be retrieved (`fetch_*`) or could not be parsed (`parse_*`). | Check the URL and the page; nothing was written. |
| `2` | Configuration or usage error: bad flag, unknown source, invalid URL, missing `DATABASE_URL` for a run. | Fix the invocation; nothing was fetched or written. |
| `3` | The page was read, but produced no usable listing (0 candidates, or every candidate held). | The markup probably changed. See §7 step 1. |

`--inspect` and `--dry-run` do not import `@workspace/db` at all, so they work
with no `DATABASE_URL` and no credential. A run (`0` arguments) refuses to
start without `DATABASE_URL`, and that check happens before any network call.

- The JSON summary on stdout is the machine-readable record; log lines go to
  stderr.
- Errors are printed as
  `{"mode":"error","category":"source|configuration|usage","code":"…","message":"…","exitCode":n}`.
  The message never contains a credential or a full connection string.
- One run is bounded: 15 s per request, 2 MB per document, 120 candidates,
  40 `.ics` fetches, 4 concurrent requests.
- `--source-url=<url>` (or `INGESTION_SOURCE_URL`) points the adapter at another
  listing URL — a staging mirror, or a local server for an end-to-end check.
  The source key and name do not change.
- `INGESTION_USER_AGENT` overrides the default `TRCalendarBot/1.0` user agent.
  Set it to the operator's contact page before the first production run.

### Scheduling

There is no scheduler in this repository and the Replit deployment target is
`autoscale`, which has no background worker. The entry point is a one-shot
process; schedule it externally, for example daily at 06:00
America/Vancouver, in a job that has `DATABASE_URL`:

```bash
pnpm --filter @workspace/api-server run ingest
```

Exit `3` from a scheduled run means "the source changed shape", not "the
service is down"; alert on it, but do not let it retry in a tight loop.

## 6. Database

`lib/db/migrations/2026-10-21-community-ingestion.sql` adds four nullable
provenance columns and one unique index to `community_events`, plus
`community_ingestion_sources` and `community_ingestion_items`.
**It has not been applied.** Apply and verify it — see
`lib/db/migrations/README.md` for the order, PostgreSQL prerequisites and the
read-only verification queries — before the first *run*. Inspection and
dry-run do not need it.

## 7. Live verification runbook

Run these in order on a network-connected host. Steps 1 and 2 need no database
and write nothing; step 3 is the separate, deliberate decision to write.

```bash
cd <repository root>
pnpm --filter @workspace/api-server run build
```

**Step 1 — inspect the page (read-only, no database).**

```bash
node artifacts/api-server/dist/ingest.mjs --inspect --pretty
```

Expected: `"candidates"` greater than zero, and `structuredEvents`,
`googleCalendarLinks`, `icsLinks` or some combination of them non-zero.
Exit `0` means the page was read and recognised.

- `candidates: 0` (exit `3`) — the page loaded but nothing matched. The markup
  differs from every assumption in §2. Do **not** add guessed selectors;
  capture a redacted HTML sample, add it as a fixture, and extend
  `extractCandidates` with tests first.
- `feedHints` non-empty — the page advertises a calendar feed. That does not
  establish a usable feed; check the publisher's intent before relying on it.
- Exit `1` — retrieval or parse failure. Check the URL, then the response.

**Step 2 — dry-run the mapping (read-only, no database).**

```bash
node artifacts/api-server/dist/ingest.mjs --dry-run --pretty
```

Expected: `counts.discovered` equal to the candidates from step 1, most of them
`ready`, and any `held` item carrying a reason that makes sense
(`ics_multiple_events`, `missing_start`, `ics_http_error`, …). Check two or
three `ready` items against the real page by eye — title, date and location.

- Exit `0` — at least one usable listing; review the counts before step 3.
- Exit `3` — the page was read but nothing is importable; treat it as step 1's
  "candidates: 0" case.
- If `icsLinks` is non-zero but every `.ics` read is `held` with
  `ics_multiple_events`, the site publishes one shared feed. Decide explicitly
  whether to ingest a feed; that is a new, reviewed adapter change, and the
  current adapter holds it on purpose.

**Step 3 — apply the migration (separate, deliberate).**

Follow `lib/db/migrations/README.md`. Do not skip the verification queries.

**Step 4 — the first write (deliberate).**

```bash
node artifacts/api-server/dist/ingest.mjs --pretty
```

Every imported event is created with `status = "draft"`, so nothing appears on
the public board. Expect exit `0` and `imported` equal to the `ready` count from
step 2.

**Step 5 — review and publish.**

In the organizer area, Events tab: the imports are drafts labelled
"Imported from Visit Tumbler Ridge". Publish one through Edit → Status →
`published` → Save. It should appear on the public calendar with a "From Visit
Tumbler Ridge" link, and the detail page should show the source attribution.
Then run step 4 again and confirm `unchanged` for every item and `imported: 0`.

## 8. What the tests prove, and what they do not

`node --test tests/*.test.ts` covers 148 cases, of which 87 are ingestion:

- parsing of representative listings, including entities, all-day values,
  timezone conversion, folded iCalendar lines and escaped text;
- missing and malformed required fields (held, never published);
- duplicate ingestion, unchanged content, in-place updates, identifier
  adoption, and the explicit refusal to merge unrelated same-title events;
- invalid and missing identifiers;
- fetch failure, HTTP failure, parsing failure and per-item `.ics` failure,
  including that previously imported events are untouched;
- protection of administrator-owned fields and of the publication decision;
- retrieval over real HTTP against a local `node:http` server serving the same
  fixtures, including a redirect, the `.ics` fetches and an HTTP failure;
- the CLI contract: argument parsing, missing `DATABASE_URL` for a run, a
  rejected source URL, and every exit code above (18 tests, no process);
- the public contract for an imported event: an imported published row
  serialises into `Event`, keeps `sourceName`, and does **not** carry
  `sourceKey`, `externalId` or `sourceContentHash`.

They do **not** prove that the real page parses, that a real database write
succeeds, that PostgreSQL accepts the migration, that the public SQL filter
(`status in ('published','cancelled')`) behaves as written, or that the
scheduler is configured. Those are exactly the steps in section 7. The public
query is SQL and no database was available, so the "drafts are not public"
guarantee is proven by reading the route (two `inArray(status, […])`
predicates) and by the serializer contract test, not by executing the query.

**What was actually executed in this sandbox:** the built CLI was run against a
local `node:http` server serving `listing-relative.html`, with `DATABASE_URL`
unset for every row below:

| Command | Result |
| --- | --- |
| `--inspect` | exit `0`, `candidates: 6` |
| `--dry-run` | exit `0`, `discovered 5 / ready 4 / held 1` |
| `--dry-run` on a page with links but no events | exit `3`, `discovered 0` |
| `--inspect` on a page with no links at all | exit `1`, `parse_page_not_recognised` |
| `--inspect` on a 404 | exit `1`, `fetch_http_error` |
| run with `DATABASE_URL` unset | exit `2`, `missing_database_url`, before any fetch |

Nothing was written to a database, and no request reached the public internet.

## 9. Next source

The District of Tumbler Ridge events calendar
(`https://www.districtoftumblerridge.ca/p/events-calendar`) is the next
milestone. It is deliberately not started here: its categories are known but
its rendering is not verified, and one working source is worth more than two
guessed ones. When its extraction is understood, it becomes a second
`IngestionSource` with its own key, and reuses `run.ts`, the store, the health
table and the review gate unchanged.
