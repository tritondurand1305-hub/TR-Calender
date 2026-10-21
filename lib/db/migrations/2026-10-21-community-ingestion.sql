-- ============================================================================
-- 2026-10-21 — community ingestion pipeline
--
-- Adds the provenance columns the Visit Tumbler Ridge importer needs on
-- community_events, plus two bookkeeping tables:
--
--   community_ingestion_sources — one row per source, with last attempt,
--                                 last success, last failure and failure code
--   community_ingestion_items   — one row per listing seen, so a listing that
--                                 cannot be parsed is held for review instead
--                                 of being published or silently dropped
--
-- Scope: additive only. Four nullable columns and one unique index on
-- community_events; two new tables. It changes no existing column, default,
-- constraint or index, rewrites no rows, and writes no data.
--
-- NOT APPLIED. This file is prepared and reviewed; it has not been executed
-- against any database. See ./README.md for the procedure and verification.
--
-- Safe to re-run: every statement is IF NOT EXISTS. If a column or table
-- already exists with a different definition it is skipped, so run the
-- verification query in ./README.md afterwards and investigate any mismatch.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Provenance on imported events
--
-- (source_key, external_id) is the deduplication key. PostgreSQL treats NULLs
-- as distinct in a unique index, so events created by an administrator (all
-- four columns NULL) never collide with each other or with imports.
-- ---------------------------------------------------------------------------

ALTER TABLE "community_events"
  ADD COLUMN IF NOT EXISTS "source_key" text;

ALTER TABLE "community_events"
  ADD COLUMN IF NOT EXISTS "external_id" text;

ALTER TABLE "community_events"
  ADD COLUMN IF NOT EXISTS "source_name" text;

ALTER TABLE "community_events"
  ADD COLUMN IF NOT EXISTS "source_content_hash" text;

CREATE UNIQUE INDEX IF NOT EXISTS "community_events_source_ref_idx"
  ON "community_events" USING btree ("source_key", "external_id");

-- ---------------------------------------------------------------------------
-- 2. Source health
--
-- One row per source. A failed run writes only this table; imported events
-- keep their previous content and last_verified_at.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "community_ingestion_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_key" text NOT NULL,
  "source_url" text NOT NULL,
  "status" text DEFAULT 'idle' NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "last_failure_at" timestamp with time zone,
  "last_error_code" text,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "last_run_summary" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "community_ingestion_sources_key_idx"
  ON "community_ingestion_sources" USING btree ("source_key");

-- ---------------------------------------------------------------------------
-- 3. Per-listing outcome, including items held for review
--
-- A listing whose required fields cannot be read is stored here with
-- outcome 'held' and a reason code. Nothing is written to community_events.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "community_ingestion_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_key" text NOT NULL,
  "external_id" text NOT NULL,
  "outcome" text NOT NULL,
  "reason_code" text,
  "source_url" text,
  "payload" jsonb,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "community_ingestion_items_ref_idx"
  ON "community_ingestion_items" USING btree ("source_key", "external_id");

COMMIT;
