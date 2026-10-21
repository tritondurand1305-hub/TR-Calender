import { comparableTitle } from "./mapping.ts";
import type { CandidateKind, ResolvedListing } from "./types.ts";

/**
 * Within-page deduplication.
 *
 * The same event often appears more than once on a listing page: as
 * structured data, as an "add to Google Calendar" link and as an `.ics` link.
 * Those are the same listing, not three events.
 *
 * Two keys are used, in this order:
 *
 *  1. the source identifier (`externalId`), which is exact;
 *  2. a normalised title plus the exact start instant, for the case where the
 *     same event is described with different identifiers by different markup.
 *
 * Key 2 deliberately requires an identical start instant as well as a similar
 * title, so two unrelated "Coffee morning" events on different days are never
 * merged. Titles alone are never enough.
 */

const KIND_PRECEDENCE: Record<CandidateKind, number> = {
  // An ICS file carries a stable UID and authoritative times.
  ics: 0,
  "structured-data": 1,
  "google-calendar": 2,
};

function contentKey(listing: ResolvedListing): string | null {
  if (!listing.title || !listing.startAt) return null;
  return `${comparableTitle(listing.title)}|${listing.startAt.toISOString()}`;
}

export function dedupeListings(listings: readonly ResolvedListing[]): ResolvedListing[] {
  const ordered = [...listings].sort(
    (a, b) => KIND_PRECEDENCE[a.kind] - KIND_PRECEDENCE[b.kind],
  );

  const seenIds = new Set<string>();
  const seenContent = new Set<string>();
  const kept: ResolvedListing[] = [];

  for (const listing of ordered) {
    if (seenIds.has(listing.externalId)) continue;
    const key = contentKey(listing);
    if (key && seenContent.has(key)) continue;

    seenIds.add(listing.externalId);
    if (key) seenContent.add(key);
    kept.push(listing);
  }

  return kept;
}
