import type { FetchLike, FetchPolicy } from "./http.ts";

/** Where a listing came from on the page. Used for within-page precedence. */
export type CandidateKind = "ics" | "structured-data" | "google-calendar";

/** A listing as found on the source page, before any secondary fetch. */
export interface RawCandidate {
  kind: CandidateKind;
  /**
   * Deterministic identifier. An iCalendar `UID` where one exists, the
   * structured-data `@id`/`url`, or a canonical URL. Never a database id.
   */
  externalId: string;
  /** Public URL a reader can open; falls back to the listing page. */
  sourceUrl: string;
  /** Secondary document to fetch (an `.ics` file), when the listing is a link only. */
  dataUrl: string | null;
  title: string | null;
  description: string | null;
  location: string | null;
  startAt: Date | null;
  endAt: Date | null;
  allDay: boolean;
  /** Raw parsed record, stored for review/debugging. */
  payload: unknown;
  /** Set when the listing is known to be unusable before any fetch. */
  problem?: string | null;
}

/** A listing after any secondary fetch, still unvalidated. */
export interface ResolvedListing {
  externalId: string;
  sourceUrl: string;
  title: string | null;
  description: string | null;
  location: string | null;
  startAt: Date | null;
  endAt: Date | null;
  allDay: boolean;
  kind: CandidateKind;
  payload: unknown;
  /**
   * Set when the listing could not be read at all (for example its `.ics`
   * file failed). Such an item is held for review, never published.
   */
  problem: string | null;
}

export interface SourcePage {
  url: string;
  body: string;
  fetchedAt: Date;
}

export interface FetchContext {
  fetch: FetchLike;
  policy: Partial<FetchPolicy>;
  now: () => Date;
}

/**
 * One public source.
 *
 * Retrieval (`fetchListing`) is separate from parsing (`extractCandidates`)
 * and from secondary resolution (`resolveCandidates`) so each can be tested on
 * its own: a fixture page exercises parsing, a fake `fetch` exercises
 * retrieval, and neither needs a database.
 */
export interface IngestionSource {
  readonly key: string;
  readonly name: string;
  readonly url: string;
  fetchListing(context: FetchContext): Promise<SourcePage>;
  extractCandidates(page: SourcePage): RawCandidate[];
  resolveCandidates(
    candidates: RawCandidate[],
    context: FetchContext,
  ): Promise<ResolvedListing[]>;
}

export type ParseErrorCode = "page_not_recognised" | "invalid_page";

export class SourceParseError extends Error {
  readonly code: ParseErrorCode;

  constructor(code: ParseErrorCode, message: string) {
    super(message);
    this.name = "SourceParseError";
    this.code = code;
  }
}
