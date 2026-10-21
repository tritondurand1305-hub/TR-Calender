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

## 5. Scheduling

There is no scheduler in this repository and the Replit deployment target is
`autoscale`, which has no background worker. The entry point is a one-shot
process; schedule it externally:

```bash
# daily at 06:00 America/Vancouver, in a scheduled job with DATABASE_URL
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run ingest
```

- Exit code `0` for `ok` **and** `partial` (held items are a review queue, not
  an outage), `1` for `failed`, `2` for configuration or usage errors.
- The JSON summary on stdout is the machine-readable record; log lines go to
  stderr.
- One run is bounded: 15 s per request, 2 MB per document, 120 candidates,
  40 `.ics` fetches, 4 concurrent requests.

## 6. Database

`lib/db/migrations/2026-10-21-community-ingestion.sql` adds four nullable
provenance columns and one unique index to `community_events`, plus
`community_ingestion_sources` and `community_ingestion_items`.
**It has not been applied.** Apply and verify it before the first real run, as
described in `lib/db/migrations/README.md`.

## 7. Live verification still required

Run these in a network-enabled environment with a database available. The
first two need no database.

```bash
pnpm --filter @workspace/api-server run build

# 1. What does the page actually contain?
node artifacts/api-server/dist/ingest.mjs --inspect --pretty

# 2. What would be imported?
node artifacts/api-server/dist/ingest.mjs --dry-run --pretty
```

Record the answer to each question:

1. **`structuredEvents`** — if above zero, JSON-LD is present and gives the
   full descriptions and detail URLs. Confirm one item against the page by eye.
2. **`googleCalendarLinks`** — if above zero, confirm a sample link really is a
   template link (opens an event, not a calendar).
3. **`icsLinks`** — if above zero, open a sample and check it is a
   single-event file. If `--dry-run` reports `ics_multiple_events`, the site
   publishes one shared feed; decide explicitly whether to ingest a feed
   (that is a new, reviewed adapter change — the current adapter holds it).
4. **`feedHints`** — a non-empty list means the page advertises a calendar
   feed. That contradicts "no complete feed is established" and should be
   checked against the publisher's intent before use.
5. **All counts zero** — the page is structured differently from every
   assumption above. Do **not** add guessed selectors. Capture a redacted HTML
   sample, add it as a fixture, and extend `extractCandidates` with tests
   first.
6. **`--dry-run` counts** — every `ready` item should correspond to a real
   event, and every `held` item should have a reason that makes sense.

Then, only after the migration is applied:

```bash
node artifacts/api-server/dist/ingest.mjs --pretty
```

and confirm in the admin Events tab that the imported events are drafts with
"Imported from Visit Tumbler Ridge", that publishing one makes it appear on the
public calendar with a working "From Visit Tumbler Ridge" link, and that a
second run reports `unchanged` for every item.

## 8. What the tests prove, and what they do not

`node --test tests/*.test.ts` covers 121 cases, of which 60 are ingestion:

- parsing of representative listings, including entities, all-day values,
  timezone conversion, folded iCalendar lines and escaped text;
- missing and malformed required fields (held, never published);
- duplicate ingestion, unchanged content, in-place updates, identifier
  adoption, and the explicit refusal to merge unrelated same-title events;
- invalid and missing identifiers;
- fetch failure, HTTP failure, parsing failure and per-item `.ics` failure,
  including that previously imported events are untouched;
- protection of administrator-owned fields and of the publication decision.

They do **not** prove that the real page parses, that a real database write
succeeds, or that the scheduler is configured. Those are exactly the steps in
section 7.

## 9. Next source

The District of Tumbler Ridge events calendar
(`https://www.districtoftumblerridge.ca/p/events-calendar`) is the next
milestone. It is deliberately not started here: its categories are known but
its rendering is not verified, and one working source is worth more than two
guessed ones. When its extraction is understood, it becomes a second
`IngestionSource` with its own key, and reuses `run.ts`, the store, the health
table and the review gate unchanged.
