/**
 * Persistence boundary for ingestion.
 *
 * The pipeline talks to this interface only, so its behaviour (dedupe,
 * updates, failure handling, review gating) is tested against an in-memory
 * implementation while the Drizzle implementation stays a thin translation of
 * these calls into SQL.
 */

export type SourceStatus = "ok" | "partial" | "failed";

export interface SourceHealthSnapshot {
  sourceKey: string;
  status: string;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  lastRunSummary: unknown;
}

export interface SourceHealthUpdate {
  sourceKey: string;
  sourceUrl: string;
  status: SourceStatus;
  attemptedAt: Date;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  lastRunSummary: unknown;
}

export interface ImportedEventRef {
  id: string;
  status: string;
  sourceContentHash: string | null;
}

/**
 * The only fields ingestion may write on a new event. Everything here is data
 * the source owns, plus the review gate (`status: "draft"`).
 */
export interface ImportedEventInsert {
  title: string;
  summary: null;
  description: string | null;
  category: string;
  startAt: Date;
  endAt: Date | null;
  allDay: boolean;
  location: string | null;
  sourceUrl: string;
  organizer: null;
  contact: null;
  cost: null;
  registrationUrl: null;
  tags: string[];
  status: "draft";
  isDemo: false;
  lastVerifiedAt: Date;
  sourceKey: string;
  externalId: string;
  sourceName: string;
  sourceContentHash: string;
}

/**
 * Fields ingestion may update on an existing imported event.
 *
 * Deliberately absent: `status` (an administrator's publication decision is
 * not the source's to change), `category`, `summary`, `tags`, `cost`,
 * `contact`, `registrationUrl`, `organizer` and `slug` (administrator-owned).
 */
export interface ImportedEventUpdate {
  title: string;
  description: string | null;
  location: string | null;
  startAt: Date;
  endAt: Date | null;
  allDay: boolean;
  sourceUrl: string;
  sourceContentHash: string;
  lastVerifiedAt: Date;
  /** Adopted when the source changed its identifier but the event is the same. */
  externalId: string;
}

export type ItemOutcome = "imported" | "updated" | "unchanged" | "held";

export interface ItemOutcomeRecord {
  sourceKey: string;
  externalId: string;
  outcome: ItemOutcome;
  reasonCode: string | null;
  sourceUrl: string | null;
  payload: unknown;
  seenAt: Date;
}

export interface IngestionStore {
  loadSource(sourceKey: string): Promise<SourceHealthSnapshot | null>;
  saveSource(update: SourceHealthUpdate): Promise<void>;
  findEventByExternalId(sourceKey: string, externalId: string): Promise<ImportedEventRef | null>;
  /**
   * Secondary lookup used only when the identifier changed: the same import
   * source, the same exact title and the same exact start instant. Never a
   * fuzzy title match.
   */
  findEventByTitleAndStart(
    sourceKey: string,
    title: string,
    startAt: Date,
  ): Promise<ImportedEventRef | null>;
  insertEvent(values: ImportedEventInsert, slug: string): Promise<ImportedEventRef>;
  updateEvent(id: string, values: ImportedEventUpdate): Promise<void>;
  /** Record "seen and unchanged", touching only the verification time. */
  markChecked(id: string, checkedAt: Date): Promise<void>;
  recordItem(record: ItemOutcomeRecord): Promise<void>;
}
