/**
 * Submission → normalizer seam.
 *
 * The deterministic `rules-v1` normalizer is provider-neutral and has no I/O.
 * This module is the only place that turns a stored submission row into
 * normalizer input and turns the result back into database column values, so
 * the mapping can be unit-tested without a database or an HTTP request.
 *
 * Guarantees:
 *  - raw submission columns are read, never written; the normalized draft lives
 *    in its own columns;
 *  - `followUpEmail` is not part of the normalizer input, so it cannot appear in
 *    the draft (and `validateDraft` rejects unknown draft fields anyway);
 *  - the reference time is the submission's `createdAt`, never a clock reading,
 *    so re-running the same row produces the same result;
 *  - nothing here throws: a failure becomes a `failed` status with a bounded
 *    error code and no draft, and a failed write is reported, not raised.
 */

import {
  rulesNormalizer,
  runNormalization,
  validateDraft,
} from "./normalizer/index.ts";
import type {
  NormalizationErrorCode,
  NormalizationResult,
  NormalizedEventDraft,
  NormalizerInput,
  NormalizerProvider,
} from "./normalizer/index.ts";

/**
 * Submission fields the normalizer is allowed to see. `followUpEmail` is
 * deliberately absent.
 */
export interface SubmissionNormalizationSource {
  readonly id: string;
  readonly title: string | null;
  readonly category: string | null;
  readonly startAt: Date | null;
  readonly endAt: Date | null;
  readonly allDay: boolean;
  readonly location: string | null;
  readonly details: string | null;
  readonly organizer: string | null;
  readonly sourceUrl: string | null;
  readonly duplicatePotential: boolean;
  readonly createdAt: Date;
}

/**
 * Stored status. `not_run` is a storage state, not a normalizer result: it is
 * the value of every row created before normalisation existed, or of a row
 * whose result could not be persisted.
 */
export const STORED_NORMALIZATION_STATUSES = [
  "not_run",
  "normalized",
  "needs_review",
  "invalid_input",
  "failed",
  "cancelled",
] as const;

export type StoredNormalizationStatus = (typeof STORED_NORMALIZATION_STATUSES)[number];

const STORED_STATUS_SET: ReadonlySet<string> = new Set(STORED_NORMALIZATION_STATUSES);

export function isStoredNormalizationStatus(value: unknown): value is StoredNormalizationStatus {
  return typeof value === "string" && STORED_STATUS_SET.has(value);
}

/** The four error codes the normalizer contract can return. */
export const NORMALIZATION_ERROR_CODES: ReadonlyArray<NormalizationErrorCode> = [
  "invalid_input",
  "invalid_provider_output",
  "internal_error",
  "cancelled",
];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(NORMALIZATION_ERROR_CODES);

export function isNormalizationErrorCode(value: unknown): value is NormalizationErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

/** Column values written in one `UPDATE` after the submission is committed. */
export interface NormalizationColumns {
  readonly normalizedDraft: NormalizedEventDraft | null;
  readonly normalizationStatus: StoredNormalizationStatus;
  readonly normalizerVersion: string | null;
  readonly normalizationReferenceTime: Date | null;
  readonly normalizationErrorCode: NormalizationErrorCode | null;
}

/** The persisted result as the admin API exposes it. */
export interface StoredNormalizationView {
  readonly status: StoredNormalizationStatus;
  readonly version: string | null;
  readonly referenceTime: string | null;
  readonly errorCode: NormalizationErrorCode | null;
  readonly draft: NormalizedEventDraft | null;
}

function toIsoOrNull(value: Date | null | undefined): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}

/**
 * Map a submission row to normalizer input.
 *
 * Values that are `null` stay null: the normalizer flags them instead of
 * inventing a date, a location or a price.
 */
export function toNormalizerInput(source: SubmissionNormalizationSource): NormalizerInput {
  return {
    title: source.title,
    category: source.category,
    startAt: toIsoOrNull(source.startAt),
    endAt: toIsoOrNull(source.endAt),
    allDay: source.allDay,
    location: source.location,
    details: source.details,
    organizer: source.organizer,
    sourceUrl: source.sourceUrl,
    rawText: null,
    duplicatePotential: source.duplicatePotential,
  };
}

/**
 * Run the normalizer and translate its result into column values.
 *
 * The reference time is the submission's own timestamp, so the stored result is
 * reproducible and is never confused with a wall-clock production time.
 */
export async function normalizeSubmission(
  source: SubmissionNormalizationSource,
  provider: NormalizerProvider = rulesNormalizer,
): Promise<NormalizationColumns> {
  const version = typeof provider?.version === "string" ? provider.version : null;
  const referenceDate =
    source.createdAt instanceof Date && !Number.isNaN(source.createdAt.getTime())
      ? source.createdAt
      : null;

  if (referenceDate === null) {
    // Without a reference time the wrapper would reject the input; record that
    // instead of reading the clock.
    return {
      normalizedDraft: null,
      normalizationStatus: "failed",
      normalizerVersion: version,
      normalizationReferenceTime: null,
      normalizationErrorCode: "invalid_input",
    };
  }

  let result: NormalizationResult;
  try {
    result = await runNormalization(provider, toNormalizerInput(source), {
      referenceTime: referenceDate,
    });
  } catch {
    // `runNormalization` is designed not to throw for JSON-shaped input. This
    // guard keeps a committed submission safe if a future provider breaks that.
    return {
      normalizedDraft: null,
      normalizationStatus: "failed",
      normalizerVersion: version,
      normalizationReferenceTime: referenceDate,
      normalizationErrorCode: "internal_error",
    };
  }

  // A draft only exists when the contract validated it. Never persist partial
  // or unvalidated provider output.
  const draft: NormalizedEventDraft | null = result.draft;
  return {
    normalizedDraft: draft,
    normalizationStatus: result.status,
    normalizerVersion: result.normalizerVersion,
    normalizationReferenceTime: result.referenceTime ? new Date(result.referenceTime) : null,
    normalizationErrorCode: result.error ? result.error.code : null,
  };
}

export type NormalizationUpdate = (
  id: string,
  values: NormalizationColumns,
) => Promise<unknown>;

/**
 * Persist a normalization result.
 *
 * Returns `false` instead of throwing when the write fails: the submission has
 * already been committed, so a storage problem must never turn a successful
 * submission into an error response. The row keeps `not_run`, which the admin
 * UI shows as "normalization did not run".
 */
export async function persistNormalization(
  id: string,
  values: NormalizationColumns,
  update: NormalizationUpdate,
): Promise<boolean> {
  try {
    await update(id, values);
    return true;
  } catch {
    return false;
  }
}

export interface NormalizationAttempt {
  /** False when the result could not be written; the submission is unaffected. */
  readonly stored: boolean;
  readonly values: NormalizationColumns;
}

/**
 * Normalize and store in one step, without ever throwing.
 *
 * This is what the submission route calls after its transaction commits.
 */
export async function normalizeAndStore(
  source: SubmissionNormalizationSource,
  update: NormalizationUpdate,
  provider: NormalizerProvider = rulesNormalizer,
): Promise<NormalizationAttempt> {
  const values = await normalizeSubmission(source, provider);
  const stored = await persistNormalization(source.id, values, update);
  return { stored, values };
}

/**
 * Read the stored result for the admin API.
 *
 * The stored draft is re-validated on every read: a row written by an older
 * rules version, a corrupt JSON value or a hand-edited draft can never be
 * returned as a trusted draft. Status is always made consistent with the draft
 * that is actually returned, and a stored draft that fails validation is
 * reported as `failed` rather than silently dropped.
 */
export function readStoredNormalization(row: {
  readonly normalizationStatus?: unknown;
  readonly normalizerVersion?: unknown;
  readonly normalizationReferenceTime?: unknown;
  readonly normalizationErrorCode?: unknown;
  readonly normalizedDraft?: unknown;
}): StoredNormalizationView {
  const status = isStoredNormalizationStatus(row.normalizationStatus)
    ? row.normalizationStatus
    : "not_run";
  const version =
    typeof row.normalizerVersion === "string" && row.normalizerVersion.trim().length > 0
      ? row.normalizerVersion
      : null;
  const referenceTime =
    row.normalizationReferenceTime instanceof Date
      ? toIsoOrNull(row.normalizationReferenceTime)
      : null;
  const errorCode = isNormalizationErrorCode(row.normalizationErrorCode)
    ? row.normalizationErrorCode
    : null;

  if (status !== "normalized" && status !== "needs_review") {
    // Failed, invalid, cancelled and not-run rows never carry a usable draft.
    return { status, version, referenceTime, errorCode, draft: null };
  }

  const validation = validateDraft(row.normalizedDraft);
  if (!validation.ok) {
    return {
      status: "failed",
      version,
      referenceTime,
      errorCode: "invalid_provider_output",
      draft: null,
    };
  }

  const draft = validation.draft;
  return {
    status: draft.reviewFlags.length > 0 ? "needs_review" : "normalized",
    version,
    referenceTime,
    // A valid draft never carries an error code.
    errorCode: null,
    draft,
  };
}
