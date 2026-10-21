/**
 * Public contract for the event normaliser.
 *
 * The API server does not depend on `zod` directly — only `@workspace/api-zod`
 * declares it, and pnpm's isolated node_modules would not resolve a bare
 * `zod` import from this package. The contract is therefore enforced by the
 * strict, dependency-free validator in this file. It mirrors what a Zod
 * object schema would enforce: exact keys, closed enums, bounded lengths,
 * ISO timestamps, absolute http(s) URLs and cross-field invariants. Swapping
 * in Zod later only requires replacing `validateDraft`.
 *
 * Field limits are taken from the OpenAPI contract:
 *   title 3-160 (SubmissionApprovalInput), summary <= 280, description <= 5000,
 *   location <= 200, organizer <= 160, contact <= 200, cost <= 160,
 *   tags <= 10 items of <= 40 characters.
 */

export const EVENT_CATEGORIES = [
  "Community Events",
  "Families & Youth",
  "Sports & Recreation",
  "Seniors & Services",
  "Community Notices",
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

const EVENT_CATEGORY_SET: ReadonlySet<string> = new Set(EVENT_CATEGORIES);

export function isEventCategory(value: unknown): value is EventCategory {
  return typeof value === "string" && EVENT_CATEGORY_SET.has(value);
}

/**
 * Closed set of review-flag codes. Changing a code is a breaking change for
 * stored drafts, so codes are append-only.
 */
export const REVIEW_FLAG_CODES = [
  "missing_title",
  "title_too_short",
  "missing_date",
  "invalid_start_at",
  "invalid_end_at",
  "end_before_start",
  "missing_location",
  "category_uncertain",
  "cost_unclear",
  "contact_not_public",
  "invalid_source_url",
  "invalid_registration_url",
  "relative_date_unresolved",
  "date_expression_unresolved",
  "duplicate_potential",
  "truncated_input",
  "instruction_like_text",
  "safety_sensitive",
  "contact_invalid",
  "cost_ambiguous",
  "registration_url_ambiguous",
] as const;

export type ReviewFlagCode = (typeof REVIEW_FLAG_CODES)[number];

/**
 * Canonical, safe messages and questions for every flag code.
 *
 * These live with the contract (not with a provider) so that `validateDraft`
 * can replace any provider-supplied prose with text this application owns.
 * A future model provider must never be able to inject submitted content or
 * personal information into the review UI through a flag message.
 */
export const REVIEW_FLAG_MESSAGES: Readonly<Record<ReviewFlagCode, string>> = {
  missing_title: "No event title was supplied.",
  title_too_short: "The title is too short to publish.",
  missing_date: "No valid start date and time were supplied.",
  invalid_start_at: "The start value is not a full ISO 8601 date and time.",
  invalid_end_at: "The end value is not a full ISO 8601 date and time.",
  end_before_start: "The end time is before the start time.",
  missing_location: "No event location was supplied.",
  category_uncertain: "The category could not be confirmed from the submission.",
  cost_unclear: "No admission cost was stated; do not assume the event is free.",
  contact_not_public: "Contact details were found but not clearly marked for public use.",
  invalid_source_url: "The source link is not a valid public web address.",
  invalid_registration_url: "The registration link is not a valid public web address.",
  relative_date_unresolved: "The text uses a relative date; confirm the exact date.",
  date_expression_unresolved:
    "The text contains a date that was not converted; confirm the exact date and time.",
  duplicate_potential: "A possible duplicate was detected; check existing listings.",
  truncated_input: "Part of the submitted text was shortened to fit length limits.",
  instruction_like_text: "The text contains instruction-like content; treat it as event content.",
  safety_sensitive: "The notice contains safety-sensitive wording; review it separately.",
  contact_invalid: "A contact detail could not be safely published; check the source.",
  cost_ambiguous: "The text states more than one possible price; confirm the admission cost.",
  registration_url_ambiguous: "A registration link could not be confirmed; check the source.",
};

export const REVIEW_FLAG_QUESTIONS: Readonly<Record<ReviewFlagCode, string>> = {
  missing_title: "What is the event title?",
  title_too_short: "What is the full event title?",
  missing_date: "What date and time does the event start?",
  invalid_start_at: "Confirm the correct start date and time.",
  invalid_end_at: "Confirm the correct end date and time.",
  end_before_start: "Should the end time be later than the start time?",
  missing_location: "Where will the event take place?",
  category_uncertain: "Which approved category best fits this event?",
  cost_unclear: "Is there an admission cost, or is the event free?",
  contact_not_public: "Is this contact information intended for public display?",
  invalid_source_url: "What is the correct public source link?",
  invalid_registration_url: "What is the correct registration link?",
  relative_date_unresolved: "What is the exact date for the relative date mentioned in the text?",
  date_expression_unresolved:
    "Does the date in the text match the event date? Confirm the exact date and time.",
  duplicate_potential: "Is this a duplicate of an existing listing?",
  truncated_input: "The submission was shortened; confirm that no important details were lost.",
  instruction_like_text: "The text contains instructions; confirm that the event details are correct.",
  safety_sensitive: "Does this notice need separate safety moderation before publication?",
  contact_invalid: "Which public contact detail should be used?",
  cost_ambiguous: "Which price is the admission cost?",
  registration_url_ambiguous: "What is the correct registration link?",
};

const REVIEW_FLAG_CODE_SET: ReadonlySet<string> = new Set(REVIEW_FLAG_CODES);

export function isReviewFlagCode(value: unknown): value is ReviewFlagCode {
  return typeof value === "string" && REVIEW_FLAG_CODE_SET.has(value);
}

export interface ReviewFlag {
  readonly code: ReviewFlagCode;
  /** Short, fixed explanation. Never contains submitted text. */
  readonly message: string;
}

/** Fields of a draft that a normaliser can change relative to the raw input. */
export const DRAFT_FIELDS = [
  "title",
  "category",
  "summary",
  "description",
  "startAt",
  "endAt",
  "allDay",
  "location",
  "organizer",
  "contact",
  "cost",
  "registrationUrl",
  "sourceUrl",
  "tags",
] as const;

export type DraftField = (typeof DRAFT_FIELDS)[number];

const DRAFT_FIELD_SET: ReadonlySet<string> = new Set(DRAFT_FIELDS);

export function isDraftField(value: unknown): value is DraftField {
  return typeof value === "string" && DRAFT_FIELD_SET.has(value);
}

export const LIMITS = {
  titleMin: 3,
  titleMax: 160,
  summaryMax: 280,
  descriptionMax: 5000,
  locationMax: 200,
  organizerMax: 160,
  contactMax: 200,
  costMax: 160,
  urlMax: 2048,
  tagMaxLength: 40,
  tagsMax: 10,
  questionMaxLength: 300,
  questionsMax: 20,
  flagMessageMax: 160,
  reviewFlagsMax: 30,
  /** Hard cap applied to any single field before cleaning. */
  inputFieldMax: 50_000,
} as const;

export interface NormalizedEventDraft {
  readonly title: string | null;
  readonly category: EventCategory;
  readonly summary: string | null;
  readonly description: string | null;
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly allDay: boolean;
  readonly location: string | null;
  readonly organizer: string | null;
  readonly contact: string | null;
  readonly cost: string | null;
  readonly registrationUrl: string | null;
  readonly sourceUrl: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly reviewFlags: ReadonlyArray<ReviewFlag>;
  readonly changedFields: ReadonlyArray<DraftField>;
  readonly unresolvedQuestions: ReadonlyArray<string>;
}

/**
 * Parsed input. `startAt`/`endAt` are still raw strings: validating them is the
 * normaliser's job, because an unparseable value must become a review flag
 * rather than an input error.
 *
 * `followUpEmail` is deliberately absent: it is private follow-up data and must
 * never be promoted to a public contact field.
 */
export interface NormalizerInput {
  readonly title: string | null;
  readonly category: string | null;
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly allDay: boolean;
  readonly location: string | null;
  readonly details: string | null;
  readonly organizer: string | null;
  readonly sourceUrl: string | null;
  readonly rawText: string | null;
  readonly duplicatePotential: boolean;
}

export interface NormalizerContext {
  /** ISO 8601 timestamp of the submission; the only clock the provider sees. */
  readonly referenceTime: string;
  readonly signal?: AbortSignal;
}

export interface NormalizationOptions {
  /** Submission timestamp. Required so output is reproducible. */
  readonly referenceTime: string | Date;
  readonly signal?: AbortSignal;
}

/** Provider-neutral interface; Phase 1 ships only the deterministic provider. */
export interface NormalizerProvider {
  readonly id: string;
  readonly version: string;
  normalize(input: NormalizerInput, context: NormalizerContext): Promise<NormalizedEventDraft>;
}

/**
 * `normalized` means "a valid draft with no review flags". It is not
 * verification, approval or permission to publish; human review is mandatory
 * for every result.
 */
export type NormalizationStatus =
  | "normalized"
  | "needs_review"
  | "invalid_input"
  | "failed"
  | "cancelled";

export type NormalizationErrorCode =
  | "invalid_input"
  | "invalid_provider_output"
  | "internal_error"
  | "cancelled";

export interface NormalizationError {
  readonly code: NormalizationErrorCode;
  /** Fixed, safe message. Never includes submitted values or stack traces. */
  readonly message: string;
}

export interface NormalizationResult {
  readonly status: NormalizationStatus;
  /** Null unless a draft passed `validateDraft`. */
  readonly draft: NormalizedEventDraft | null;
  readonly reviewFlags: ReadonlyArray<ReviewFlag>;
  readonly error: NormalizationError | null;
  readonly normalizerVersion: string;
  /**
   * The supplied submission/reference timestamp, canonicalised to ISO 8601.
   *
   * This is not a wall-clock production time: the normalizer is deterministic
   * and never reads the clock. Null when the reference time was invalid or when
   * the result is `cancelled` before a reference time could be read.
   */
  readonly referenceTime: string | null;
}

export const NORMALIZER_VERSION = "rules-v1";

/* -------------------------------------------------------------------------- */
/* Timestamps                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A full date-time with an explicit timezone. Date-only values are rejected
 * because treating them as midnight would invent a time.
 */
const ISO_TIMESTAMP_INPUT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate an ISO 8601 date-time with an explicit offset and return the
 * canonical UTC form, or null when it is not usable.
 *
 * Values outside 1900-2200 are rejected as data-entry errors.
 */
export function canonicalIsoTimestamp(value: string): string | null {
  const match = ISO_TIMESTAMP_INPUT.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);

  if (month < 1 || month > 12) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  // Date.parse() rolls impossible dates forward (2026-02-30 -> 2026-03-02).
  // Round-trip through UTC to reject them instead of silently correcting.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return null;
  }

  const zone = match[8];
  if (zone !== "Z") {
    const zoneHours = Number(zone.slice(1, 3));
    const zoneMinutes = Number(zone.slice(4, 6));
    if (zoneHours > 23 || zoneMinutes > 59) return null;
  }

  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  const date = new Date(time);
  const utcYear = date.getUTCFullYear();
  if (utcYear < 1900 || utcYear > 2200) return null;
  return date.toISOString();
}

export function isCanonicalIsoTimestamp(value: string): boolean {
  // Round-trip through the same parser the producer uses. Regex + Date.parse
  // alone would accept impossible dates (2026-02-30 rolls to 2026-03-02) and
  // years outside the 1900-2200 data-entry range.
  return canonicalIsoTimestamp(value) === value;
}

export function toIsoReferenceTime(value: string | Date): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== "string") return null;
  return canonicalIsoTimestamp(value.trim());
}

/* -------------------------------------------------------------------------- */
/* URLs                                                                        */
/* -------------------------------------------------------------------------- */

export function isValidHttpUrl(value: string): boolean {
  if (value.length === 0 || value.length > LIMITS.urlMax) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Input parsing                                                               */
/* -------------------------------------------------------------------------- */

export type InputParseResult =
  | { readonly ok: true; readonly input: NormalizerInput }
  | { readonly ok: false; readonly message: string };

class InputFieldError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Invalid input field: ${field}`);
    this.name = "InputFieldError";
    this.field = field;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readStringField(record: Record<string, unknown>, field: string): string | null {
  const raw = record[field];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new InputFieldError(field);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > LIMITS.inputFieldMax
    ? trimmed.slice(0, LIMITS.inputFieldMax)
    : trimmed;
}

function readTimestampField(record: Record<string, unknown>, field: string): string | null {
  const raw = record[field];
  if (raw === undefined || raw === null) return null;
  if (raw instanceof Date) {
    // An invalid Date is still a supplied value; keep a sentinel that fails
    // validation so the caller gets a review flag instead of silent data loss.
    return Number.isNaN(raw.getTime()) ? "Invalid Date" : raw.toISOString();
  }
  if (typeof raw !== "string") throw new InputFieldError(field);
  const trimmed = raw.trim();
  return trimmed || null;
}

function readBooleanField(
  record: Record<string, unknown>,
  field: string,
): boolean {
  const raw = record[field];
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "boolean") throw new InputFieldError(field);
  return raw;
}

/**
 * Parse untrusted submission-shaped input into a stable structure.
 *
 * Wrong types are reported as `invalid_input`; values that are the right type
 * but semantically wrong (bad timestamp, unsafe URL) are left for the
 * normaliser to flag. `followUpEmail` is intentionally ignored.
 */
export function parseNormalizerInput(value: unknown): InputParseResult {
  if (!isPlainObject(value)) {
    return { ok: false, message: "Submission input must be a plain object." };
  }

  try {
    const input: NormalizerInput = {
      title: readStringField(value, "title"),
      category: readStringField(value, "category"),
      startAt: readTimestampField(value, "startAt"),
      endAt: readTimestampField(value, "endAt"),
      allDay: readBooleanField(value, "allDay"),
      location: readStringField(value, "location"),
      details: readStringField(value, "details"),
      organizer: readStringField(value, "organizer"),
      sourceUrl: readStringField(value, "sourceUrl"),
      rawText: readStringField(value, "rawText"),
      duplicatePotential: readBooleanField(value, "duplicatePotential"),
    };
    return { ok: true, input };
  } catch (error) {
    if (error instanceof InputFieldError) {
      return { ok: false, message: `${error.field} must be of the expected type.` };
    }
    return { ok: false, message: "Submission input could not be read." };
  }
}

/* -------------------------------------------------------------------------- */
/* Output validation                                                           */
/* -------------------------------------------------------------------------- */

export type DraftValidation =
  | { readonly ok: true; readonly draft: NormalizedEventDraft }
  | { readonly ok: false; readonly issues: ReadonlyArray<string> };

const DRAFT_KEYS = [
  "title",
  "category",
  "summary",
  "description",
  "startAt",
  "endAt",
  "allDay",
  "location",
  "organizer",
  "contact",
  "cost",
  "registrationUrl",
  "sourceUrl",
  "tags",
  "reviewFlags",
  "changedFields",
  "unresolvedQuestions",
] as const;

/** Control characters allowed nowhere; newline is handled per field below. */
const CONTROL_CHARACTERS = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/;
const INLINE_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/**
 * Strictly validate an untrusted draft (for example, output from a future
 * provider) before it can be stored or shown for review.
 *
 * Any issue means the value is not a usable draft. Callers must not fall back
 * to a partial object.
 */
export function validateDraft(value: unknown): DraftValidation {
  const issues: string[] = [];

  if (!isPlainObject(value)) {
    return { ok: false, issues: ["Draft must be a plain object."] };
  }

  const expected = new Set<string>(DRAFT_KEYS);
  let unexpected = 0;
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) unexpected += 1;
  }
  if (unexpected > 0) issues.push("Draft contains unexpected fields.");
  for (const key of DRAFT_KEYS) {
    if (!(key in value)) issues.push(`Draft is missing the ${key} field.`);
  }

  const title = readNullableString(value.title, LIMITS.titleMax, "title", issues);
  if (title !== null && title.length < LIMITS.titleMin) {
    issues.push(`title must be at least ${LIMITS.titleMin} characters.`);
  }

  const summary = readNullableString(value.summary, LIMITS.summaryMax, "summary", issues);
  const description = readNullableString(
    value.description,
    LIMITS.descriptionMax,
    "description",
    issues,
    { multiline: true },
  );
  const location = readNullableString(value.location, LIMITS.locationMax, "location", issues);
  const organizer = readNullableString(value.organizer, LIMITS.organizerMax, "organizer", issues);
  const contact = readNullableString(value.contact, LIMITS.contactMax, "contact", issues);
  const cost = readNullableString(value.cost, LIMITS.costMax, "cost", issues);
  const registrationUrl = readNullableUrl(value.registrationUrl, "registrationUrl", issues);
  const sourceUrl = readNullableUrl(value.sourceUrl, "sourceUrl", issues);
  const startAt = readNullableTimestamp(value.startAt, "startAt", issues);
  const endAt = readNullableTimestamp(value.endAt, "endAt", issues);

  let category: EventCategory = "Community Events";
  if (isEventCategory(value.category)) {
    category = value.category;
  } else {
    issues.push("category must be one of the approved categories.");
  }

  const allDay = readBoolean(value.allDay, "allDay", issues);
  const tags = readTags(value.tags, issues);
  const reviewFlags = readReviewFlags(value.reviewFlags, issues);
  const changedFields = readChangedFields(value.changedFields, issues);
  // Validate the shape of provider-supplied questions, then discard the text:
  // the review UI always receives the canonical question for each flag code.
  readQuestions(value.unresolvedQuestions, issues);
  const unresolvedQuestions = [
    ...new Set(reviewFlags.map((flag) => REVIEW_FLAG_QUESTIONS[flag.code])),
  ].slice(0, LIMITS.questionsMax);

  const codes = new Set<ReviewFlagCode>(reviewFlags.map((flag) => flag.code));

  if (title === null && !codes.has("missing_title") && !codes.has("title_too_short")) {
    issues.push("A draft without a title must be flagged missing_title or title_too_short.");
  }
  if (startAt === null && !codes.has("missing_date")) {
    issues.push("A draft without a start timestamp must be flagged missing_date.");
  }
  if (
    startAt !== null &&
    endAt !== null &&
    Date.parse(endAt) < Date.parse(startAt) &&
    !codes.has("end_before_start")
  ) {
    issues.push("An end time before the start must be flagged end_before_start.");
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const draft: NormalizedEventDraft = {
    title,
    category,
    summary,
    description,
    startAt,
    endAt,
    allDay,
    location,
    organizer,
    contact,
    cost,
    registrationUrl,
    sourceUrl,
    tags,
    reviewFlags,
    changedFields,
    unresolvedQuestions,
  };
  return { ok: true, draft };
}

function readNullableString(
  raw: unknown,
  maxLength: number,
  field: string,
  issues: string[],
  options: { multiline?: boolean } = {},
): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") {
    issues.push(`${field} must be a string or null.`);
    return null;
  }
  if (raw.length === 0) issues.push(`${field} must not be empty; use null instead.`);
  if (raw.length > maxLength) issues.push(`${field} exceeds ${maxLength} characters.`);
  if (raw !== raw.trim()) issues.push(`${field} must not have leading or trailing whitespace.`);
  if (options.multiline) {
    if (CONTROL_CHARACTERS.test(raw)) issues.push(`${field} contains control characters.`);
  } else if (INLINE_CONTROL_CHARACTERS.test(raw)) {
    issues.push(`${field} contains control characters or line breaks.`);
  }
  return raw;
}

function readNullableUrl(raw: unknown, field: string, issues: string[]): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string" || !isValidHttpUrl(raw)) {
    issues.push(`${field} must be an absolute http(s) URL.`);
    return null;
  }
  return raw;
}

function readNullableTimestamp(raw: unknown, field: string, issues: string[]): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string" || !isCanonicalIsoTimestamp(raw)) {
    issues.push(`${field} must be a canonical ISO 8601 timestamp.`);
    return null;
  }
  return raw;
}

function readBoolean(raw: unknown, field: string, issues: string[]): boolean {
  if (typeof raw !== "boolean") {
    issues.push(`${field} must be a boolean.`);
    return false;
  }
  return raw;
}

function readTags(raw: unknown, issues: string[]): string[] {
  if (!Array.isArray(raw)) {
    issues.push("tags must be an array.");
    return [];
  }
  if (raw.length > LIMITS.tagsMax) {
    issues.push(`tags must contain at most ${LIMITS.tagsMax} entries.`);
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > LIMITS.tagMaxLength) {
      issues.push(`each tag must be 1-${LIMITS.tagMaxLength} characters.`);
      continue;
    }
    if (entry !== entry.trim() || /\s/.test(entry)) {
      issues.push("each tag must be a single trimmed token.");
      continue;
    }
    if (seen.has(entry)) {
      issues.push("tags must not contain duplicates.");
      continue;
    }
    seen.add(entry);
    tags.push(entry);
  }
  return tags;
}

function readReviewFlags(raw: unknown, issues: string[]): ReviewFlag[] {
  if (!Array.isArray(raw)) {
    issues.push("reviewFlags must be an array.");
    return [];
  }
  if (raw.length > LIMITS.reviewFlagsMax) {
    issues.push(`reviewFlags must contain at most ${LIMITS.reviewFlagsMax} entries.`);
  }
  const flags: ReviewFlag[] = [];
  const seen = new Set<ReviewFlagCode>();
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      issues.push("each review flag must be an object.");
      continue;
    }
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !("code" in entry) || !("message" in entry)) {
      issues.push("each review flag must contain exactly code and message.");
      continue;
    }
    if (!isReviewFlagCode(entry.code)) {
      issues.push("reviewFlags contains an unknown code.");
      continue;
    }
    if (seen.has(entry.code)) {
      issues.push("reviewFlags contains duplicate codes.");
      continue;
    }
    const message = entry.message;
    if (
      typeof message !== "string" ||
      message.length === 0 ||
      message.length > LIMITS.flagMessageMax ||
      message !== message.trim() ||
      /[\r\n]/.test(message)
    ) {
      issues.push(`review flag messages must be 1-${LIMITS.flagMessageMax} characters on one line.`);
      continue;
    }
    seen.add(entry.code);
    // The provider supplies a message only to satisfy the shape of the
    // contract; the text is discarded and replaced with the application-owned
    // canonical message for the code. This prevents PII or prompt-injected
    // prose from reaching the review UI.
    flags.push({ code: entry.code, message: REVIEW_FLAG_MESSAGES[entry.code] });
  }
  return flags;
}

function readChangedFields(raw: unknown, issues: string[]): DraftField[] {
  if (!Array.isArray(raw)) {
    issues.push("changedFields must be an array.");
    return [];
  }
  const fields: DraftField[] = [];
  const seen = new Set<DraftField>();
  for (const entry of raw) {
    if (!isDraftField(entry)) {
      issues.push("changedFields contains an unknown field.");
      continue;
    }
    if (seen.has(entry)) {
      issues.push("changedFields must not contain duplicates.");
      continue;
    }
    seen.add(entry);
    fields.push(entry);
  }
  return fields;
}

function readQuestions(raw: unknown, issues: string[]): string[] {
  if (!Array.isArray(raw)) {
    issues.push("unresolvedQuestions must be an array.");
    return [];
  }
  if (raw.length > LIMITS.questionsMax) {
    issues.push(`unresolvedQuestions must contain at most ${LIMITS.questionsMax} entries.`);
  }
  const questions: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > LIMITS.questionMaxLength ||
      entry !== entry.trim() ||
      /[\r\n]/.test(entry)
    ) {
      issues.push(`each question must be 1-${LIMITS.questionMaxLength} characters on one line.`);
      continue;
    }
    if (seen.has(entry)) {
      issues.push("unresolvedQuestions must not contain duplicates.");
      continue;
    }
    seen.add(entry);
    questions.push(entry);
  }
  return questions;
}
