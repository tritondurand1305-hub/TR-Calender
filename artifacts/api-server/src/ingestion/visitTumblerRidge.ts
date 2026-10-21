import { mapWithConcurrency } from "./concurrency.ts";
import { parseGoogleCalendarDates, parseIsoDate } from "./dateParsing.ts";
import {
  absoluteUrl,
  canonicalizeUrl,
  extractAnchors,
  extractFeedHints,
  extractJsonLdBlocks,
} from "./html.ts";
import { fetchDocument, SourceFetchError } from "./http.ts";
import { parseIcsCalendar } from "./ics.ts";
import type {
  FetchContext,
  IngestionSource,
  RawCandidate,
  ResolvedListing,
  SourcePage,
} from "./types.ts";
import { SourceParseError } from "./types.ts";

/**
 * Visit Tumbler Ridge — the first community source.
 *
 * What the architect verified about the public page:
 *   - it lists events with title, date and start/end times where available,
 *     location and description;
 *   - it links to event detail pages;
 *   - each event has individual Google Calendar and ICS links.
 *
 * What is NOT verified, and is therefore treated as an assumption here:
 *   - the exact markup (no class names, ids or component structure are used);
 *   - whether the page carries schema.org JSON-LD;
 *   - whether the Google Calendar links use the standard `action=TEMPLATE`
 *     query format;
 *   - whether the ICS links are per-event files or one shared feed.
 *
 * The adapter therefore reads only standard structures (JSON-LD, Google
 * Calendar template links, iCalendar files). Everything it does is exercised
 * by fixtures in `tests/fixtures/visit-tumbler-ridge/`, and the live page still
 * has to be confirmed on a network-enabled runtime. See
 * docs/ingestion-visit-tumbler-ridge.md.
 */

export const VISIT_TUMBLER_RIDGE_KEY = "visit-tumbler-ridge";
export const VISIT_TUMBLER_RIDGE_NAME = "Visit Tumbler Ridge";
export const VISIT_TUMBLER_RIDGE_EVENTS_URL = "https://www.visittumblerridge.ca/events";

/** Bounds the number of secondary requests a single page can cause. */
const MAX_ICS_FETCHES = 40;
const ICS_CONCURRENCY = 4;

interface StructuredEventRecord {
  [key: string]: unknown;
}

function isEventType(type: unknown): boolean {
  if (typeof type === "string") return /event$/i.test(type.trim());
  if (Array.isArray(type)) return type.some(isEventType);
  return false;
}

function collectStructuredEvents(value: unknown, into: StructuredEventRecord[] = []): StructuredEventRecord[] {
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredEvents(item, into);
    return into;
  }
  if (!value || typeof value !== "object") return into;
  const record = value as StructuredEventRecord;
  if (isEventType(record["@type"])) into.push(record);
  if (record["@graph"]) collectStructuredEvents(record["@graph"], into);
  return into;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function structuredLocation(value: unknown): string | null {
  const direct = asString(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = structuredLocation(entry);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const place = value as Record<string, unknown>;
  const name = asString(place.name);
  if (name) return name;
  const address = place.address;
  const addressText = asString(address);
  if (addressText) return addressText;
  if (address && typeof address === "object") {
    const parts = [
      asString((address as Record<string, unknown>).streetAddress),
      asString((address as Record<string, unknown>).addressLocality),
    ].filter((part): part is string => Boolean(part));
    if (parts.length > 0) return parts.join(", ");
  }
  return null;
}

function structuredCandidate(record: StructuredEventRecord, pageUrl: string): RawCandidate | null {
  const title = asString(record.name) ?? asString(record.headline);
  const startRaw = asString(record.startDate);
  const endRaw = asString(record.endDate);
  const start = startRaw ? parseIsoDate(startRaw) : null;
  const end = endRaw ? parseIsoDate(endRaw) : null;

  const url = asString(record.url) ? absoluteUrl(asString(record.url) as string, pageUrl) : null;
  const identifier = asString(record["@id"]);
  const canonicalSelf = url ?? (identifier ? absoluteUrl(identifier, pageUrl) : null);

  // Without a URL or an @id, fall back to the listing page plus the start
  // instant: stable for a fixed schedule, and documented as a fallback.
  const startKey = start && start.ok ? start.value.date.toISOString() : "no-date";
  const externalId = canonicalSelf
    ? `structured:${canonicalizeUrl(canonicalSelf)}`
    : `structured:${pageUrl}#${startKey}`;

  const status = asString(record.eventStatus);
  const problem = status && /cancelled/i.test(status) ? "event_cancelled" : null;

  return {
    kind: "structured-data",
    externalId,
    sourceUrl: canonicalSelf ?? pageUrl,
    dataUrl: null,
    title,
    description: asString(record.description),
    location: structuredLocation(record.location),
    startAt: start && start.ok ? start.value.date : null,
    endAt: end && end.ok ? end.value.date : null,
    allDay: Boolean(start && start.ok && start.value.allDay),
    payload: record,
    problem,
  };
}

interface GoogleCalendarFields {
  text: string | null;
  dates: string | null;
  details: string | null;
  location: string | null;
  ctz: string | null;
}

function readGoogleCalendarLink(href: string, pageUrl: string): { url: string; fields: GoogleCalendarFields } | null {
  const absolute = absoluteUrl(href, pageUrl);
  if (!absolute) return null;
  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!["calendar.google.com", "www.google.com", "google.com"].includes(host)) return null;
  if (!url.pathname.toLowerCase().includes("calendar")) return null;

  const action = url.searchParams.get("action");
  const text = url.searchParams.get("text");
  const dates = url.searchParams.get("dates");
  const isTemplate = (action ?? "").toUpperCase() === "TEMPLATE";
  const isEventEdit = /eventedit/i.test(url.pathname);
  if (!isTemplate && !isEventEdit) return null;
  if (!text && !dates) return null;

  return {
    url: absolute,
    fields: {
      text,
      dates,
      details: url.searchParams.get("details"),
      location: url.searchParams.get("location"),
      ctz: url.searchParams.get("ctz"),
    },
  };
}

function googleCalendarCandidate(href: string, pageUrl: string): RawCandidate | null {
  const link = readGoogleCalendarLink(href, pageUrl);
  if (!link) return null;

  const parsedDates = link.fields.dates
    ? parseGoogleCalendarDates(link.fields.dates, link.fields.ctz)
    : null;

  return {
    kind: "google-calendar",
    // The template URL encodes the event content, so it changes when the event
    // changes. It is the documented fallback identifier for this format.
    externalId: `gcal:${canonicalizeUrl(link.url)}`,
    sourceUrl: pageUrl,
    dataUrl: null,
    title: link.fields.text,
    description: link.fields.details,
    location: link.fields.location,
    startAt: parsedDates?.start.date ?? null,
    endAt: parsedDates?.end?.date ?? null,
    allDay: parsedDates?.start.allDay ?? false,
    payload: { href: link.url, fields: link.fields },
    problem: null,
  };
}

/**
 * A per-event iCalendar link.
 *
 * Accepted:
 *   - an `.ics` file served by the source page's own host (the site generated
 *     it for one event);
 *   - a Google-hosted `.ics` carrying an `eid` parameter, which identifies one
 *     event.
 *
 * Rejected on purpose: a shared `basic.ics` calendar export without `eid`.
 * That is a feed, and the source has not been verified to publish one.
 */
export function perEventIcsUrl(href: string, pageUrl: string): string | null {
  let absolute = absoluteUrl(href, pageUrl);
  if (!absolute) return null;
  if (/^webcal:\/\//i.test(absolute)) {
    absolute = `https://${absolute.slice("webcal://".length)}`;
  }
  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!/\.ics$/i.test(url.pathname)) return null;

  const pageHost = new URL(pageUrl).hostname.toLowerCase();
  const host = url.hostname.toLowerCase();
  if (host === pageHost) return absolute;

  const googleHosted = ["calendar.google.com", "www.google.com", "google.com"].includes(host);
  if (googleHosted && url.searchParams.has("eid")) return absolute;
  return null;
}

function icsCandidate(href: string, pageUrl: string): RawCandidate | null {
  const dataUrl = perEventIcsUrl(href, pageUrl);
  if (!dataUrl) return null;
  return {
    kind: "ics",
    externalId: `ics:${canonicalizeUrl(dataUrl)}`,
    sourceUrl: pageUrl,
    dataUrl,
    // Everything else is read from the file itself.
    title: null,
    description: null,
    location: null,
    startAt: null,
    endAt: null,
    allDay: false,
    payload: { href: dataUrl },
    problem: null,
  };
}

export function extractCandidates(page: SourcePage): RawCandidate[] {
  const anchors = extractAnchors(page.body);
  const blocks = extractJsonLdBlocks(page.body);
  if (anchors.length === 0 && blocks.length === 0) {
    throw new SourceParseError(
      "page_not_recognised",
      "The page contains no links and no structured data",
    );
  }

  const candidates: RawCandidate[] = [];

  for (const block of blocks) {
    for (const record of collectStructuredEvents(block)) {
      const candidate = structuredCandidate(record, page.url);
      if (candidate) candidates.push(candidate);
    }
  }

  for (const anchor of anchors) {
    const google = googleCalendarCandidate(anchor.href, page.url);
    if (google) {
      candidates.push(google);
      continue;
    }
    const ics = icsCandidate(anchor.href, page.url);
    if (ics) candidates.push(ics);
  }

  return candidates;
}

async function resolveIcs(candidate: RawCandidate, context: FetchContext): Promise<ResolvedListing> {
  const base: ResolvedListing = {
    externalId: candidate.externalId,
    sourceUrl: candidate.sourceUrl,
    title: null,
    description: null,
    location: null,
    startAt: null,
    endAt: null,
    allDay: false,
    kind: "ics",
    payload: candidate.payload,
    problem: null,
  };
  if (!candidate.dataUrl) return { ...base, problem: "ics_missing_url" };

  let body: string;
  try {
    const document = await fetchDocument(candidate.dataUrl, {
      fetch: context.fetch,
      policy: context.policy,
      kind: "calendar",
      now: context.now,
    });
    body = document.body;
  } catch (error) {
    const code = error instanceof SourceFetchError ? error.code : "network_error";
    return { ...base, problem: `ics_${code}` };
  }

  const parsed = parseIcsCalendar(body);
  if (parsed.events.length === 0) return { ...base, problem: "ics_no_events" };
  if (parsed.events.length > 1) {
    // A single-event link that returns several events is a feed. Importing a
    // guessed subset would misrepresent the calendar, so hold it for a human
    // decision instead.
    return { ...base, problem: "ics_multiple_events" };
  }

  const event = parsed.events[0] as (typeof parsed.events)[number];
  if (event.problem) return { ...base, problem: event.problem };

  const externalId = event.uid
    ? `ics:uid:${event.uid}`
    : `ics:${canonicalizeUrl(candidate.dataUrl)}`;

  return {
    ...base,
    externalId,
    sourceUrl: event.url ?? candidate.sourceUrl,
    title: event.summary,
    description: event.description,
    location: event.location,
    startAt: event.start?.date ?? null,
    endAt: event.end?.date ?? null,
    allDay: event.start?.allDay ?? false,
    payload: {
      href: candidate.dataUrl,
      uid: event.uid,
      status: event.status,
      start: event.start?.date.toISOString() ?? null,
      end: event.end?.date.toISOString() ?? null,
    },
  };
}

export async function resolveCandidates(
  candidates: RawCandidate[],
  context: FetchContext,
): Promise<ResolvedListing[]> {
  const icsCandidates = candidates.filter((candidate) => candidate.kind === "ics" && !candidate.problem);
  const allowed = new Set(
    icsCandidates.slice(0, MAX_ICS_FETCHES).map((candidate) => candidate.externalId),
  );

  return mapWithConcurrency(candidates, ICS_CONCURRENCY, async (candidate) => {
    if (candidate.problem) {
      return {
        externalId: candidate.externalId,
        sourceUrl: candidate.sourceUrl,
        title: candidate.title,
        description: candidate.description,
        location: candidate.location,
        startAt: candidate.startAt,
        endAt: candidate.endAt,
        allDay: candidate.allDay,
        kind: candidate.kind,
        payload: candidate.payload,
        problem: candidate.problem,
      } satisfies ResolvedListing;
    }
    if (candidate.kind !== "ics") {
      return {
        externalId: candidate.externalId,
        sourceUrl: candidate.sourceUrl,
        title: candidate.title,
        description: candidate.description,
        location: candidate.location,
        startAt: candidate.startAt,
        endAt: candidate.endAt,
        allDay: candidate.allDay,
        kind: candidate.kind,
        payload: candidate.payload,
        problem: null,
      } satisfies ResolvedListing;
    }
    if (!allowed.has(candidate.externalId)) {
      return {
        externalId: candidate.externalId,
        sourceUrl: candidate.sourceUrl,
        title: null,
        description: null,
        location: null,
        startAt: null,
        endAt: null,
        allDay: false,
        kind: "ics",
        payload: candidate.payload,
        problem: "ics_item_limit_exceeded",
      } satisfies ResolvedListing;
    }
    return resolveIcs(candidate, context);
  });
}

/** Diagnostic summary of a page, used by the CLI before trusting the adapter. */
export function inspectPage(page: SourcePage): Record<string, unknown> {
  const anchors = extractAnchors(page.body);
  const blocks = extractJsonLdBlocks(page.body);
  return {
    url: page.url,
    bytes: page.body.length,
    anchors: anchors.length,
    jsonLdBlocks: blocks.length,
    structuredEvents: blocks.reduce<number>(
      (count, block) => count + collectStructuredEvents(block).length,
      0,
    ),
    googleCalendarLinks: anchors.filter((anchor) => googleCalendarCandidate(anchor.href, page.url))
      .length,
    icsLinks: anchors.filter((anchor) => perEventIcsUrl(anchor.href, page.url)).length,
    feedHints: extractFeedHints(page.body)
      .map((hint) => absoluteUrl(hint.href, page.url))
      .filter((href): href is string => Boolean(href)),
  };
}

export async function fetchListing(context: FetchContext): Promise<SourcePage> {
  const document = await fetchDocument(VISIT_TUMBLER_RIDGE_EVENTS_URL, {
    fetch: context.fetch,
    policy: context.policy,
    kind: "html",
    now: context.now,
  });
  return {
    url: document.url,
    body: document.body,
    fetchedAt: document.fetchedAt,
  };
}

export const visitTumblerRidgeSource: IngestionSource = {
  key: VISIT_TUMBLER_RIDGE_KEY,
  name: VISIT_TUMBLER_RIDGE_NAME,
  url: VISIT_TUMBLER_RIDGE_EVENTS_URL,
  fetchListing,
  extractCandidates,
  resolveCandidates,
};
