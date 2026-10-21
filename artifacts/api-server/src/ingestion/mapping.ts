import { createHash } from "node:crypto";
import { endsBeforeStart } from "../lib/eventInterval.ts";
import { htmlToText } from "./html.ts";
import type { ResolvedListing } from "./types.ts";

/**
 * Turning a resolved source listing into the existing event model.
 *
 * Rules that matter more than the code:
 *
 *  - A date is never invented. If the listing has no readable start, the item
 *    is held for review instead of being published "sometime".
 *  - An all-day value with no end gets no end. The source's end date is
 *    exclusive in both formats we read, and guessing an inclusive end would
 *    display the wrong day.
 *  - The mapper only produces fields the source owns. Summary, tags, cost,
 *    contact and registration are administrator-maintained and are never
 *    written by ingestion.
 */

export const MAPPER_VERSION = "visit-tumbler-ridge-v1";

/** Both are limits the existing event contract already enforces. */
const TITLE_MAX = 160;
const LOCATION_MAX = 200;
const DESCRIPTION_MAX = 5000;

export const DEFAULT_IMPORT_CATEGORY = "Community Events";

export type HoldReason =
  | "missing_title"
  | "missing_start"
  | "end_before_start"
  | "missing_source_url";

export interface MappedEvent {
  title: string;
  description: string | null;
  location: string | null;
  startAt: Date;
  endAt: Date | null;
  allDay: boolean;
  sourceUrl: string;
  sourceKey: string;
  sourceName: string;
  externalId: string;
  sourceContentHash: string;
  category: string;
  /** Only ever `draft`: ingestion cannot publish. */
  status: "draft";
  isDemo: false;
  tags: string[];
  summary: null;
  lastVerifiedAt: Date;
}

export type MappingResult =
  | { ok: true; values: MappedEvent }
  | { ok: false; reason: HoldReason; detail: string };

function trimTo(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 0 ? text.slice(0, max) : null;
}

function plainText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = /<[a-z][\s\S]*>/i.test(value) ? htmlToText(value) : value;
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return normalized.length > 0 ? normalized.slice(0, max) : null;
}

function httpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Stable hash of the fields the source owns. Used to tell an unchanged
 * listing from a changed one without diffing every column on every run.
 */
export function contentHash(values: {
  title: string;
  startAt: Date;
  endAt: Date | null;
  allDay: boolean;
  location: string | null;
  description: string | null;
  sourceUrl: string;
}): string {
  const canonical = [
    MAPPER_VERSION,
    values.title,
    values.startAt.toISOString(),
    values.endAt ? values.endAt.toISOString() : "",
    values.allDay ? "all-day" : "timed",
    values.location ?? "",
    values.description ?? "",
    values.sourceUrl,
  ].join("\u0000");
  return createHash("sha256").update(canonical).digest("hex");
}

export function mapListing(
  listing: ResolvedListing,
  context: { sourceKey: string; sourceName: string; checkedAt: Date },
): MappingResult {
  const title = trimTo(listing.title, TITLE_MAX);
  if (!title) {
    return { ok: false, reason: "missing_title", detail: "The listing has no readable title" };
  }

  if (!listing.startAt || Number.isNaN(listing.startAt.getTime())) {
    return { ok: false, reason: "missing_start", detail: "The listing has no readable start date" };
  }

  const startAt = listing.startAt;
  const endAt = listing.allDay ? null : listing.endAt;
  if (endAt && endsBeforeStart(startAt, endAt)) {
    return {
      ok: false,
      reason: "end_before_start",
      detail: "The listing ends before it starts",
    };
  }

  const sourceUrl = httpUrl(listing.sourceUrl);
  if (!sourceUrl) {
    return {
      ok: false,
      reason: "missing_source_url",
      detail: "The listing has no public http(s) URL to attribute",
    };
  }

  const location = trimTo(listing.location, LOCATION_MAX);
  const description = plainText(listing.description, DESCRIPTION_MAX);

  return {
    ok: true,
    values: {
      title,
      description,
      location,
      startAt,
      endAt,
      allDay: listing.allDay,
      sourceUrl,
      sourceKey: context.sourceKey,
      sourceName: context.sourceName,
      externalId: listing.externalId,
      sourceContentHash: contentHash({
        title,
        startAt,
        endAt,
        allDay: listing.allDay,
        location,
        description,
        sourceUrl,
      }),
      category: DEFAULT_IMPORT_CATEGORY,
      status: "draft",
      isDemo: false,
      tags: [],
      summary: null,
      lastVerifiedAt: context.checkedAt,
    },
  };
}

/** Normalised title used only for exact-content deduplication. */
export function comparableTitle(title: string): string {
  return title
    .toLocaleLowerCase("en-CA")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
