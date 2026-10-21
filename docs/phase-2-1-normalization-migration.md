# Phase 2.1 — normalization migration artifact

**Branch:** `arena/ba533186-tr-calender`
**Base:** `3256c8b` (Phase 2 integration report)
**Date:** 2026-10-20
**Status:** prepared and reviewed, **not applied**. No database was contacted and
no SQL was executed.

## Why a standalone file

The repository has **no migration framework**. `lib/db/drizzle.config.ts`
defines only `schema` and `dialect` (no `out`), `lib/db/package.json` exposes
only `push` / `push-force`, and no `.sql` file or Drizzle migrations directory
has ever existed. The only mechanism is `drizzle-kit push`, which diffs the
entire schema against a live database and produces no reviewable artifact.

Because that setup cannot express a narrowly scoped, reviewed change, this phase
adds an explicit standalone SQL migration under `lib/db/migrations/`, with the
conventions and procedures documented in
[`lib/db/migrations/README.md`](../../lib/db/migrations/README.md). Nothing in
that directory runs automatically, and `drizzle-kit push` does not read it.

## Artifact

[`lib/db/migrations/2026-10-20-community-submissions-normalization.sql`](../../lib/db/migrations/2026-10-20-community-submissions-normalization.sql)

SHA-256 of the file as committed:

```
1472c056077e419f66992a4149cbfaadc88deee86a89c2b9b4846a6692cfb0cc
```

```sql
BEGIN;

-- Fail fast rather than queue behind a long transaction holding this table.
-- The lock itself is metadata-only and very brief (see README section 3, Locking).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "community_submissions"
  ADD COLUMN IF NOT EXISTS "normalized_draft" jsonb;

ALTER TABLE "community_submissions"
  ADD COLUMN IF NOT EXISTS "normalization_status" text NOT NULL DEFAULT 'not_run';

ALTER TABLE "community_submissions"
  ADD COLUMN IF NOT EXISTS "normalizer_version" text;

ALTER TABLE "community_submissions"
  ADD COLUMN IF NOT EXISTS "normalization_reference_time" timestamp with time zone;

ALTER TABLE "community_submissions"
  ADD COLUMN IF NOT EXISTS "normalization_error_code" text;

COMMIT;
```

Additive only: five `ADD COLUMN` statements on one table. No `UPDATE`, `INSERT`,
`DELETE`, `DROP`, `TRUNCATE`, index, constraint or other table. `IF NOT EXISTS`
makes a re-run safe; a pre-existing column with a different definition is
skipped, which the verification query exposes.

## Schema review

Each statement was compared with `lib/db/src/schema/community.ts`:

| Drizzle definition | SQL | Type | Nullable | Default |
| --- | --- | --- | --- | --- |
| `jsonb("normalized_draft").$type<unknown>()` | `jsonb` | ✅ | yes | none |
| `text("normalization_status").notNull().default("not_run")` | `text NOT NULL DEFAULT 'not_run'` | ✅ | no | ✅ |
| `text("normalizer_version")` | `text` | ✅ | yes | none |
| `timestamp("normalization_reference_time", { withTimezone: true })` | `timestamp with time zone` | ✅ | yes | none |
| `text("normalization_error_code")` | `text` | ✅ | yes | none |

Drizzle's `timestamp(..., { withTimezone: true })` maps to `timestamptz`
(`timestamp with time zone`), which is what the SQL declares. Column names use
the explicit snake_case names from the schema, so no naming-strategy change can
rename them.

## Existing rows

`normalization_status` is `NOT NULL DEFAULT 'not_run'`; on PostgreSQL 11+ the
default is stored in the catalog, so existing rows read `not_run` without a
table rewrite. The other four columns are `NULL`, which is the truthful value
for a submission that has not been normalized. No backfill is required or
performed. The application maps `not_run` to "normalization did not run" and
shows the original submission.

## Verification (read-only)

The full query and expected output are in
[`lib/db/migrations/README.md`](../../lib/db/migrations/README.md#4-verify-read-only).
It checks `information_schema.columns` for the five columns, their
`data_type`/`udt_name`, `is_nullable` and `column_default`, confirms the columns
exist on `community_submissions` only, and confirms existing rows group under
`not_run`.

## Deployment and rollback

Deployment order is: apply the migration → verify → deploy the Phase 2 API
server → deploy the Phase 2 UI. Reversing steps 1 and 3 leaves the admin
submission list failing (it selects every schema column) and normalization
results unstorable; public submissions still succeed because a failed
normalization write is caught.

Rollback is to redeploy the previous application version and **keep the
columns**: they are nullable/defaulted, older code ignores them, and they may
already hold normalization results. This phase deliberately provides no down
script and does not propose dropping columns. A later removal would need a
separate reviewed change that first archives `normalized_draft` and the four
companion values (see the README).

## Static checks run

No database, no SQL execution. Checks were limited to filesystem and type
checks:

| Check | Result |
| --- | --- |
| Statement audit of the SQL file (targets, statement kinds, nullability, transaction) | 5 `ADD COLUMN` statements, all on `community_submissions`; no DML/`DROP`/index/constraint statements |
| Column-by-column comparison with `community.ts` | 5/5 names, types, nullability and default match |
| `git diff --stat` / `git status` | only this document and `lib/db/migrations/**` |
| `pnpm run typecheck` | exit 0 (no TypeScript changed) |
| `cd artifacts/api-server && node --test tests/*.test.ts` | 61/61 pass (no runtime change) |
| SQL syntax | inspection only — no PostgreSQL client, server, or SQL parser is installed in this environment, and none was fetched |

The SQL was not parsed by a PostgreSQL grammar and not executed, so "reviewed"
here means statement-by-statement comparison against the Drizzle schema and the
PostgreSQL documentation, not a database round-trip.

## Confirmation

- No database was contacted; no connection string was read, printed or stored.
- No SQL was executed, including the migration file itself.
- `drizzle-kit push` / `push-force` were not run.
- Nothing was deployed, merged into `main`, or applied to any environment.
- No application behavior, API contract, generated file, dependency or
  unrelated schema was changed.
