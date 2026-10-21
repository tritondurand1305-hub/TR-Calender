-- ============================================================================
-- 2026-10-20 — community_submissions: normalizer result columns
--
-- Phase 2.1 migration artifact. NOT APPLIED to any database.
--
-- Scope: additive only. Adds the five columns the Phase 2 normalizer writes
-- after a submission commits. It changes no existing column, default,
-- constraint or index, touches no other table, and writes no rows.
--
-- Safe to re-run: every statement is ADD COLUMN IF NOT EXISTS. If a column
-- already exists with a different definition the statement is skipped, so run
-- the verification query in ./README.md afterwards and investigate any
-- mismatch instead of fixing it blind.
--
-- This repository has no migration framework (no drizzle/ output directory, no
-- `drizzle-kit generate`/`migrate` script, no version table). See ./README.md
-- for why this file is standalone and how it relates to `drizzle-kit push`.
-- ============================================================================

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
