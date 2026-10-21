import { and, eq, sql } from "drizzle-orm";
import {
  db,
  eventsTable,
  ingestionItemsTable,
  ingestionSourcesTable,
} from "@workspace/db";
import type {
  ImportedEventInsert,
  ImportedEventRef,
  ImportedEventUpdate,
  IngestionStore,
  ItemOutcomeRecord,
  SourceHealthSnapshot,
  SourceHealthUpdate,
} from "./store.ts";

/**
 * Drizzle implementation of the ingestion store.
 *
 * Not exercised by the test suite: there is no database in this environment
 * and the task forbids connecting to one. The pipeline's behaviour is covered
 * by the in-memory store in `tests/ingestion-run.test.ts`; this file only
 * translates those calls into the statements below, which will be exercised
 * the first time the CLI runs against a real database.
 */
export function createDrizzleIngestionStore(): IngestionStore {
  return {
    async loadSource(sourceKey: string): Promise<SourceHealthSnapshot | null> {
      const [row] = await db
        .select({
          sourceKey: ingestionSourcesTable.sourceKey,
          status: ingestionSourcesTable.status,
          lastAttemptAt: ingestionSourcesTable.lastAttemptAt,
          lastSuccessAt: ingestionSourcesTable.lastSuccessAt,
          lastFailureAt: ingestionSourcesTable.lastFailureAt,
          lastErrorCode: ingestionSourcesTable.lastErrorCode,
          consecutiveFailures: ingestionSourcesTable.consecutiveFailures,
          lastRunSummary: ingestionSourcesTable.lastRunSummary,
        })
        .from(ingestionSourcesTable)
        .where(eq(ingestionSourcesTable.sourceKey, sourceKey))
        .limit(1);
      return row ?? null;
    },

    async saveSource(update: SourceHealthUpdate): Promise<void> {
      const now = new Date();
      await db
        .insert(ingestionSourcesTable)
        .values({
          sourceKey: update.sourceKey,
          sourceUrl: update.sourceUrl,
          status: update.status,
          lastAttemptAt: update.attemptedAt,
          lastSuccessAt: update.lastSuccessAt,
          lastFailureAt: update.lastFailureAt,
          lastErrorCode: update.lastErrorCode,
          consecutiveFailures: update.consecutiveFailures,
          lastRunSummary: update.lastRunSummary,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: ingestionSourcesTable.sourceKey,
          set: {
            sourceUrl: update.sourceUrl,
            status: update.status,
            lastAttemptAt: update.attemptedAt,
            lastSuccessAt: update.lastSuccessAt,
            lastFailureAt: update.lastFailureAt,
            lastErrorCode: update.lastErrorCode,
            consecutiveFailures: update.consecutiveFailures,
            lastRunSummary: update.lastRunSummary,
            updatedAt: now,
          },
        });
    },

    async findEventByExternalId(
      sourceKey: string,
      externalId: string,
    ): Promise<ImportedEventRef | null> {
      const [row] = await db
        .select({
          id: eventsTable.id,
          status: eventsTable.status,
          sourceContentHash: eventsTable.sourceContentHash,
        })
        .from(eventsTable)
        .where(
          and(eq(eventsTable.sourceKey, sourceKey), eq(eventsTable.externalId, externalId)),
        )
        .limit(1);
      return row ?? null;
    },

    async findEventByTitleAndStart(
      sourceKey: string,
      title: string,
      startAt: Date,
    ): Promise<ImportedEventRef | null> {
      const [row] = await db
        .select({
          id: eventsTable.id,
          status: eventsTable.status,
          sourceContentHash: eventsTable.sourceContentHash,
        })
        .from(eventsTable)
        .where(
          and(
            eq(eventsTable.sourceKey, sourceKey),
            sql`lower(${eventsTable.title}) = lower(${title})`,
            eq(eventsTable.startAt, startAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async insertEvent(values: ImportedEventInsert, slug: string): Promise<ImportedEventRef> {
      const [row] = await db
        .insert(eventsTable)
        .values({ ...values, slug })
        .returning({
          id: eventsTable.id,
          status: eventsTable.status,
          sourceContentHash: eventsTable.sourceContentHash,
        });
      if (!row) throw new Error("Imported event insert returned no row");
      return row;
    },

    async updateEvent(id: string, values: ImportedEventUpdate): Promise<void> {
      await db
        .update(eventsTable)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(eventsTable.id, id));
    },

    async markChecked(id: string, checkedAt: Date): Promise<void> {
      // Deliberately not touching updatedAt: an unchanged listing is verified,
      // not edited.
      await db
        .update(eventsTable)
        .set({ lastVerifiedAt: checkedAt })
        .where(eq(eventsTable.id, id));
    },

    async recordItem(record: ItemOutcomeRecord): Promise<void> {
      const now = new Date();
      await db
        .insert(ingestionItemsTable)
        .values({
          sourceKey: record.sourceKey,
          externalId: record.externalId,
          outcome: record.outcome,
          reasonCode: record.reasonCode,
          sourceUrl: record.sourceUrl,
          payload: record.payload,
          lastSeenAt: record.seenAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [ingestionItemsTable.sourceKey, ingestionItemsTable.externalId],
          set: {
            outcome: record.outcome,
            reasonCode: record.reasonCode,
            sourceUrl: record.sourceUrl,
            payload: record.payload,
            lastSeenAt: record.seenAt,
            updatedAt: now,
          },
        });
    },
  };
}
