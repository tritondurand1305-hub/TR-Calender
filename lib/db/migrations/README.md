# Database migrations

This directory holds explicit, reviewable SQL for changes that must not be left
to an implicit schema push. The repository has **no migration framework**:

- `lib/db/drizzle.config.ts` defines only `schema` and `dialect`; there is no
  `out` directory.
- `lib/db/package.json` exposes only `push` / `push-force` (`drizzle-kit push`).
- No `drizzle-kit generate`, no `migrate` script, no `__drizzle_migrations`
  version table, and no `.sql` file has ever been committed.

The established mechanism is therefore `drizzle-kit push`, which diffs the whole
Drizzle schema against a live database. That is convenient in development, but
it is not a reviewable, narrowly scoped change: it can propose unrelated
differences and it produces no artifact. For schema changes that must be planned
and reviewed, this directory is used instead.

**Nothing here runs automatically.** Applying a file is a manual, reviewed
operation performed by an operator with access to the target database. No
credentials, connection strings or `.env` files belong in this repository or in
these files.

---

## Files

| File | Purpose |
| --- | --- |
| `2026-10-20-community-submissions-normalization.sql` | Adds five additive columns to `community_submissions` for the Phase 2 normalizer. **Not applied.** |
| `2026-10-21-community-ingestion.sql` | Adds four provenance columns and a unique index to `community_events`, plus `community_ingestion_sources` and `community_ingestion_items`. **Not applied.** |

---

## Applying the normalization migration

### 1. Prerequisites

1. Confirm the target database and schema. Drizzle maps to the default
   `public` schema; the verification query below does not hard-code a schema, so
   a different one is visible rather than hidden.
2. Confirm the current state is the expected one — the five columns absent or
   already correct. Run the verification query in step 4 **before** applying.
3. Take a backup or snapshot according to your normal operational policy. The
   change is additive, but a backup is still the rollback of last resort.
4. Check for long-running transactions on `community_submissions`. The migration
   sets `lock_timeout = '5s'`; if it fails with a lock timeout, nothing was
   changed (the transaction rolls back) and it can be retried in a quieter
   window.

### 2. Apply

Run the file with any PostgreSQL client, supplying the connection through your
normal mechanism (the environment of the session, a secret manager, a `psql`
service definition). Do **not** put the connection string in this repository.

```bash
# Example only — provide DATABASE_URL yourself; it is not stored here.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/2026-10-20-community-submissions-normalization.sql
```

`-v ON_ERROR_STOP=1` makes `psql` stop on the first error. The file is wrapped in
a single transaction, so it applies completely or not at all.

If your runner already wraps each file in a transaction, remove the `BEGIN;` and
`COMMIT;` lines first: a nested `COMMIT` would close the runner's transaction
early. The migration has no other transaction dependency.

### 3. Locking and expected duration

All five statements take an `ACCESS EXCLUSIVE` lock on `community_submissions`,
but only for the instant needed to update the catalog — not for a table scan.

- `ADD COLUMN` with no default: catalog-only; existing rows read `NULL` from the
  missing attribute. No rewrite.
- `ADD COLUMN ... NOT NULL DEFAULT 'not_run'`: PostgreSQL 11 and later store the
  default in `pg_attribute.attmissingval` and skip the rewrite. The column reads
  `'not_run'` for every existing row without validating a table scan.
- The transaction is short, so the 5s `lock_timeout` is ample. On a busy table it
  can still expire; nothing is changed in that case and the attempt can be
  retried.

On PostgreSQL 10 or older the `NOT NULL DEFAULT` column would force a table
rewrite and hold the lock for its duration. Confirm the server version
(`SHOW server_version;`) if the target is not known to be 11+.

### 4. Verify (read-only)

```sql
SELECT table_schema,
       column_name,
       data_type,
       udt_name,
       is_nullable,
       column_default
FROM information_schema.columns
WHERE table_name = 'community_submissions'
  AND column_name IN (
    'normalized_draft',
    'normalization_status',
    'normalizer_version',
    'normalization_reference_time',
    'normalization_error_code'
  )
  AND table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY column_name;
```

Expected result (five rows, `public` unless the database uses another schema):

| column_name | data_type | udt_name | is_nullable | column_default |
| --- | --- | --- | --- | --- |
| `normalization_error_code` | `text` | `text` | `YES` | `NULL` |
| `normalization_reference_time` | `timestamp with time zone` | `timestamptz` | `YES` | `NULL` |
| `normalization_status` | `text` | `text` | `NO` | `'not_run'::text` |
| `normalizer_version` | `text` | `text` | `YES` | `NULL` |
| `normalized_draft` | `jsonb` | `jsonb` | `YES` | `NULL` |

Two further read-only checks:

```sql
-- 1. The five columns exist on this table only.
SELECT table_name, count(*) AS matching_columns
FROM information_schema.columns
WHERE column_name IN (
  'normalized_draft', 'normalization_status', 'normalizer_version',
  'normalization_reference_time', 'normalization_error_code'
)
AND table_schema NOT IN ('pg_catalog', 'information_schema')
GROUP BY table_name;

-- Expected: exactly one row — community_submissions, matching_columns = 5.


-- 2. Existing rows are represented as not_run (no backfill was performed).
SELECT normalization_status, count(*) AS submissions
FROM community_submissions
GROUP BY normalization_status
ORDER BY normalization_status;

-- Expected: every existing row has normalization_status = 'not_run'.
-- A row can only be in another state if the Phase 2 server has already run
-- against this database after the migration.
```

### 5. Existing rows and why no backfill is needed

- `normalized_draft`, `normalizer_version`, `normalization_reference_time` and
  `normalization_error_code` are nullable; `NULL` is the truthful value for a
  submission that has not been normalized.
- `normalization_status` is `NOT NULL DEFAULT 'not_run'`. PostgreSQL 11 and later
  store the default in the catalog when the column is added, so existing rows
  read `not_run` without a table rewrite and without an `UPDATE`.
- The application treats `not_run` as "normalization did not run" and shows the
  original submission for review, so old rows are fully readable. There is
  nothing to backfill.

### 6. Deployment order

The application code from Phase 2 expects these columns to exist.

1. Apply this migration.
2. Run the verification query above.
3. Deploy the Phase 2 API server.
4. Deploy the Phase 2 admin UI.

Do not reverse 1 and 3. Before the migration, the Phase 2 admin submission list
fails (it selects every schema column) and normalization results cannot be
stored. New public submissions would still be accepted — a failed normalization
write is caught — but those rows would stay `not_run`.

Note: `scripts/post-merge.sh` runs `pnpm --filter db push`, a `drizzle-kit push`
against whatever `DATABASE_URL` the environment provides. The filter (`db`) does
not match the workspace package name (`@workspace/db`), so that step may be a
no-op. Either way, do not rely on it for this change and do not merge this
branch to `main` as the deployment mechanism. After the migration is applied, a
schema push should report no changes for these five columns.

---

## Applying the ingestion migration

Order matters only in one direction: the migration must be applied **before**
the build that writes these columns ships.

### 1. Prerequisites

1. The normalization migration should already be applied (it is the earlier
   file). It is independent, but running them in filename order keeps the
   deployed schema traceable.
2. Take a backup or snapshot according to normal operational policy.
3. Check for long-running transactions on `community_events`; the file uses the
   same 5 s `lock_timeout`, and a timeout leaves the database unchanged.

### 2. Apply

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/2026-10-21-community-ingestion.sql
```

### 3. Verify (read-only)

```sql
-- Four nullable columns, one unique index.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'community_events'
  AND column_name IN ('source_key', 'external_id', 'source_name', 'source_content_hash')
ORDER BY column_name;

-- Expected: four rows, all text, all nullable, no default.

SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'community_events'
ORDER BY indexname;

-- Expected: community_events_slug_idx (unique, slug) and
--           community_events_source_ref_idx (unique, source_key, external_id).

SELECT table_name
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
  AND table_name IN ('community_ingestion_sources', 'community_ingestion_items')
ORDER BY table_name;

-- Expected: both tables.

-- After the first real run only:
SELECT source_key, status, last_attempt_at, last_success_at, last_failure_at,
       last_error_code, consecutive_failures
FROM community_ingestion_sources;
```

Existing rows need no backfill: the four new event columns are nullable, so
every manually created or submission-approved event simply has `NULL`
provenance and is invisible to the importer's lookups. The two new tables start
empty.

### 4. Rollback

**Leave the columns and tables in place and redeploy the previous build.** The
change is additive, older code ignores the new columns, and the tables hold the
record of what was imported, which is worth keeping. Dropping
`community_ingestion_items` or the provenance columns would erase that record
and cause the next run to re-import every listing as a new draft. If removal is
genuinely required, treat it as a separate reviewed change that first archives
both tables, exactly as described in the generic rollback section below.

---

## Rollback (normalization migration)

**Preferred rollback: deploy the previous application version and leave the
columns in place.**

- The change is additive and every new column is nullable or defaulted, so the
  pre-Phase-2 server ignores them. Drizzle selects only the columns it knows
  about, so an older build keeps working against the migrated database.
- Leaving the columns preserves any normalization results already written.

**Do not drop the columns as part of a routine rollback.** Once the Phase 2
server has run, `normalized_draft` (and the four companion values) hold derived
but not reproducible review data: the source submission can be re-normalized
only with the same normalizer version and reference time. A drop is therefore a
destructive, data-losing operation.

If removal is genuinely required (for example, a policy decision to stop storing
drafts), treat it as a separate change:

1. Stop writing the columns (deploy code that no longer normalizes).
2. Archive the data first, with a reviewed, read-only export such as
   `COPY (SELECT id, normalized_draft, normalization_status, normalizer_version,
   normalization_reference_time, normalization_error_code
   FROM community_submissions) TO ...` into approved storage.
3. Only then run a separately reviewed `ALTER TABLE ... DROP COLUMN` change,
   after confirming the archive and that no code reads the columns.

This migration deliberately ships **no** down script.

---

## Relationship to the Drizzle schema

`lib/db/src/schema/community.ts` (submissions table) must stay in sync with this
file. The five definitions and their SQL equivalents:

| Drizzle | SQL | Nullable | Default |
| --- | --- | --- | --- |
| `jsonb("normalized_draft").$type<unknown>()` | `jsonb` | yes | none |
| `text("normalization_status").notNull().default("not_run")` | `text` | no | `'not_run'` |
| `text("normalizer_version")` | `text` | yes | none |
| `timestamp("normalization_reference_time", { withTimezone: true })` | `timestamp with time zone` | yes | none |
| `text("normalization_error_code")` | `text` | yes | none |

No other column, index (`community_submissions_reference_idx`) or constraint is
touched by the migration.

The ingestion migration follows the same rule for `community_events`:

| Drizzle | SQL | Nullable |
| --- | --- | --- |
| `text("source_key")` | `text` | yes |
| `text("external_id")` | `text` | yes |
| `text("source_name")` | `text` | yes |
| `text("source_content_hash")` | `text` | yes |
| `uniqueIndex("community_events_source_ref_idx")` | `CREATE UNIQUE INDEX ... USING btree (source_key, external_id)` | — |

`community_ingestion_sources` and `community_ingestion_items` mirror the Drizzle
definitions in the same file, including their unique indexes on `source_key`
and `(source_key, external_id)`.

---

## Review checklist for any new file in this directory

- [ ] Additive only, unless the destructive nature is stated in the file header.
- [ ] Only the intended table(s) and column(s) referenced — search the SQL for
      other table names before committing.
- [ ] No `DROP`, `TRUNCATE`, `DELETE`, `UPDATE` or data backfill.
- [ ] Idempotent where the statement allows it (`ADD COLUMN IF NOT EXISTS`,
      `CREATE INDEX IF NOT EXISTS`, …).
- [ ] A read-only verification query with expected output is included.
- [ ] Deployment order and rollback are documented.
- [ ] The file was **not** executed as part of the change that added it.
