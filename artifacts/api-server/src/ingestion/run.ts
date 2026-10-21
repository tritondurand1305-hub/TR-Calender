import { slugFor } from "../lib/slug.ts";
import { dedupeListings } from "./dedupe.ts";
import { SourceFetchError, type FetchLike, type FetchPolicy } from "./http.ts";
import { mapListing } from "./mapping.ts";
import type { IngestionStore } from "./store.ts";
import { SourceParseError, type IngestionSource, type ResolvedListing, type SourcePage } from "./types.ts";

/**
 * The ingestion pipeline.
 *
 * Order matters and is the safety property of the whole slice:
 *
 *   1. read the source page            — failure is recorded, nothing is written
 *   2. parse it                        — failure is recorded, nothing is written
 *   3. resolve secondary documents     — a per-item failure holds that item only
 *   4. validate each listing           — a held item never becomes an event
 *   5. insert as `draft`               — a person still has to publish it
 *   6. update in place on change       — matched by source identifier, never by
 *                                        a similar title alone
 *
 * Events are never deleted by ingestion. A failed run leaves every previously
 * imported event exactly as it was, including its lastVerifiedAt.
 */

export interface IngestionLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface IngestionCounts {
  discovered: number;
  imported: number;
  updated: number;
  unchanged: number;
  held: number;
  errors: number;
}

export interface HeldSample {
  externalId: string;
  reason: string;
  title: string | null;
}

export type IngestionOutcome = "ok" | "partial" | "failed";

export interface IngestionRunSummary {
  sourceKey: string;
  sourceName: string;
  startedAt: string;
  finishedAt: string;
  outcome: IngestionOutcome;
  errorCode: string | null;
  pageUrl: string | null;
  counts: IngestionCounts;
  heldReasons: Record<string, number>;
  heldSamples: HeldSample[];
}

export interface IngestionOptions {
  source: IngestionSource;
  fetch: FetchLike;
  now?: () => Date;
  policy?: Partial<FetchPolicy>;
  maxItems?: number;
  logger?: IngestionLogger;
}

export interface IngestionPreviewItem {
  externalId: string;
  title: string | null;
  startAt: string | null;
  allDay: boolean;
  kind: string;
  outcome: "ready" | "held";
  reason: string | null;
}

export interface IngestionPreview {
  sourceKey: string;
  sourceName: string;
  pageUrl: string;
  fetchedAt: string;
  truncated: number;
  counts: { discovered: number; ready: number; held: number };
  heldReasons: Record<string, number>;
  items: IngestionPreviewItem[];
}

const EMPTY_COUNTS = (): IngestionCounts => ({
  discovered: 0,
  imported: 0,
  updated: 0,
  unchanged: 0,
  held: 0,
  errors: 0,
});

export function failureCode(error: unknown): string {
  if (error instanceof SourceFetchError) return `fetch_${error.code}`;
  if (error instanceof SourceParseError) return `parse_${error.code}`;
  return "unknown_error";
}

interface Collected {
  page: SourcePage;
  listings: ResolvedListing[];
  truncated: number;
}

async function collect(options: IngestionOptions): Promise<Collected> {
  const now = options.now ?? (() => new Date());
  const context = {
    fetch: options.fetch,
    policy: options.policy ?? {},
    now,
  };

  const page = await options.source.fetchListing(context);
  const candidates = options.source.extractCandidates(page);

  const maxItems = options.maxItems ?? 120;
  const truncated = Math.max(0, candidates.length - maxItems);
  const limited = truncated > 0 ? candidates.slice(0, maxItems) : candidates;

  const resolved = await options.source.resolveCandidates(limited, context);
  return { page, listings: dedupeListings(resolved), truncated };
}

function buildSummary(
  options: IngestionOptions,
  startedAt: Date,
  finishedAt: Date,
  outcome: IngestionOutcome,
  errorCode: string | null,
  pageUrl: string | null,
  counts: IngestionCounts,
  heldReasons: Record<string, number>,
  heldSamples: HeldSample[],
): IngestionRunSummary {
  return {
    sourceKey: options.source.key,
    sourceName: options.source.name,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    outcome,
    errorCode,
    pageUrl,
    counts,
    heldReasons,
    heldSamples,
  };
}

/**
 * Fetch, parse and validate without writing anything. Used by
 * `--dry-run`/`--inspect` to verify a live page before trusting it.
 */
export async function previewIngestion(options: IngestionOptions): Promise<IngestionPreview> {
  const collected = await collect(options);
  const checkedAt = (options.now ?? (() => new Date()))();
  const counts = { discovered: collected.listings.length, ready: 0, held: 0 };
  const heldReasons: Record<string, number> = {};
  const items: IngestionPreviewItem[] = [];

  for (const listing of collected.listings) {
    const mapped = listing.problem
      ? { ok: false as const, reason: listing.problem }
      : mapListing(listing, {
          sourceKey: options.source.key,
          sourceName: options.source.name,
          checkedAt,
        });
    if (!mapped.ok) {
      counts.held += 1;
      heldReasons[mapped.reason] = (heldReasons[mapped.reason] ?? 0) + 1;
      items.push({
        externalId: listing.externalId,
        title: listing.title,
        startAt: listing.startAt ? listing.startAt.toISOString() : null,
        allDay: listing.allDay,
        kind: listing.kind,
        outcome: "held",
        reason: mapped.reason,
      });
      continue;
    }
    counts.ready += 1;
    items.push({
      externalId: listing.externalId,
      title: listing.title,
      startAt: listing.startAt ? listing.startAt.toISOString() : null,
      allDay: listing.allDay,
      kind: listing.kind,
      outcome: "ready",
      reason: null,
    });
  }

  return {
    sourceKey: options.source.key,
    sourceName: options.source.name,
    pageUrl: collected.page.url,
    fetchedAt: collected.page.fetchedAt.toISOString(),
    truncated: collected.truncated,
    counts,
    heldReasons,
    items,
  };
}

export async function runIngestion(
  options: IngestionOptions & { store: IngestionStore },
): Promise<IngestionRunSummary> {
  const store = options.store;
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const previous = await store.loadSource(options.source.key);
  const counts = EMPTY_COUNTS();
  const heldReasons: Record<string, number> = {};
  const heldSamples: HeldSample[] = [];

  let collected: Collected;
  try {
    collected = await collect(options);
  } catch (error) {
    const code = failureCode(error);
    const finishedAt = now();
    await store.saveSource({
      sourceKey: options.source.key,
      sourceUrl: options.source.url,
      status: "failed",
      attemptedAt: startedAt,
      // A failed run must not look like a successful check.
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastFailureAt: finishedAt,
      lastErrorCode: code,
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      lastRunSummary: { outcome: "failed", errorCode: code },
    });
    options.logger?.error(
      { sourceKey: options.source.key, errorCode: code },
      "Ingestion run failed before any listing was read",
    );
    return buildSummary(
      options,
      startedAt,
      finishedAt,
      "failed",
      code,
      null,
      counts,
      heldReasons,
      heldSamples,
    );
  }

  for (const listing of collected.listings) {
    counts.discovered += 1;
    const mapped = listing.problem
      ? { ok: false as const, reason: listing.problem, detail: "The listing could not be read" }
      : mapListing(listing, {
          sourceKey: options.source.key,
          sourceName: options.source.name,
          checkedAt: startedAt,
        });

    if (!mapped.ok) {
      counts.held += 1;
      heldReasons[mapped.reason] = (heldReasons[mapped.reason] ?? 0) + 1;
      if (heldSamples.length < 20) {
        heldSamples.push({
          externalId: listing.externalId,
          reason: mapped.reason,
          title: listing.title,
        });
      }
      try {
        await store.recordItem({
          sourceKey: options.source.key,
          externalId: listing.externalId,
          outcome: "held",
          reasonCode: mapped.reason,
          sourceUrl: listing.sourceUrl,
          payload: listing.payload,
          seenAt: startedAt,
        });
      } catch {
        // The item is still held; only its audit row is missing.
        counts.errors += 1;
      }
      continue;
    }

    const values = mapped.values;

    try {
      let existing = await store.findEventByExternalId(
        options.source.key,
        values.externalId,
      );
      let adoptedIdentifier = false;
      if (!existing) {
        // The identifier may have changed (a regenerated link, a new UID).
        // Only an exact title and exact start instant are accepted as the same
        // listing; similar titles alone never match.
        const twin = await store.findEventByTitleAndStart(
          options.source.key,
          values.title,
          values.startAt,
        );
        if (twin) {
          existing = twin;
          adoptedIdentifier = true;
        }
      }

      if (!existing) {
        await store.insertEvent(
          {
            title: values.title,
            summary: null,
            description: values.description,
            category: values.category,
            startAt: values.startAt,
            endAt: values.endAt,
            allDay: values.allDay,
            location: values.location,
            sourceUrl: values.sourceUrl,
            organizer: null,
            contact: null,
            cost: null,
            registrationUrl: null,
            tags: [],
            status: "draft",
            isDemo: false,
            lastVerifiedAt: values.lastVerifiedAt,
            sourceKey: values.sourceKey,
            externalId: values.externalId,
            sourceName: values.sourceName,
            sourceContentHash: values.sourceContentHash,
          },
          slugFor(values.title),
        );
        counts.imported += 1;
        await store.recordItem({
          sourceKey: options.source.key,
          externalId: values.externalId,
          outcome: "imported",
          reasonCode: null,
          sourceUrl: values.sourceUrl,
          payload: listing.payload,
          seenAt: startedAt,
        });
        continue;
      }

      if (existing.sourceContentHash === values.sourceContentHash && !adoptedIdentifier) {
        await store.markChecked(existing.id, values.lastVerifiedAt);
        counts.unchanged += 1;
        await store.recordItem({
          sourceKey: options.source.key,
          externalId: values.externalId,
          outcome: "unchanged",
          reasonCode: null,
          sourceUrl: values.sourceUrl,
          payload: listing.payload,
          seenAt: startedAt,
        });
        continue;
      }

      // Content changed (or the identifier was adopted). Only the fields the
      // source owns are written; an administrator's edits to summary, tags,
      // cost, contact, registration and the publication status survive.
      await store.updateEvent(existing.id, {
        title: values.title,
        description: values.description,
        location: values.location,
        startAt: values.startAt,
        endAt: values.endAt,
        allDay: values.allDay,
        sourceUrl: values.sourceUrl,
        sourceContentHash: values.sourceContentHash,
        lastVerifiedAt: values.lastVerifiedAt,
        externalId: values.externalId,
      });
      counts.updated += 1;
      await store.recordItem({
        sourceKey: options.source.key,
        externalId: values.externalId,
        outcome: "updated",
        reasonCode: null,
        sourceUrl: values.sourceUrl,
        payload: listing.payload,
        seenAt: startedAt,
      });
    } catch {
      // One bad row must not stop the run or roll back anything already
      // written. The listing stays held and the source is marked partial.
      counts.errors += 1;
      heldReasons.storage_error = (heldReasons.storage_error ?? 0) + 1;
      try {
        await store.recordItem({
          sourceKey: options.source.key,
          externalId: values.externalId,
          outcome: "held",
          reasonCode: "storage_error",
          sourceUrl: values.sourceUrl,
          payload: listing.payload,
          seenAt: startedAt,
        });
      } catch {
        // The store is unavailable; the run summary still reports the error.
      }
    }
  }

  const finishedAt = now();
  const noItems = collected.listings.length === 0;
  const outcome: IngestionOutcome =
    counts.errors > 0 || counts.held > 0 || noItems ? "partial" : "ok";
  const errorCode =
    counts.errors > 0
      ? "item_errors"
      : counts.held > 0
        ? "items_held"
        : noItems
          ? "no_items_found"
          : null;

  await store.saveSource({
    sourceKey: options.source.key,
    sourceUrl: options.source.url,
    status: outcome,
    attemptedAt: startedAt,
    lastSuccessAt: finishedAt,
    lastFailureAt: previous?.lastFailureAt ?? null,
    lastErrorCode: errorCode,
    consecutiveFailures: 0,
    lastRunSummary: {
      outcome,
      counts,
      heldReasons,
      truncated: collected.truncated,
    },
  });

  if (outcome !== "ok") {
    options.logger?.warn(
      { sourceKey: options.source.key, errorCode, counts, heldReasons },
      "Ingestion finished with items needing attention",
    );
  }

  return buildSummary(
    options,
    startedAt,
    finishedAt,
    outcome,
    errorCode,
    collected.page.url,
    counts,
    heldReasons,
    heldSamples,
  );
}
