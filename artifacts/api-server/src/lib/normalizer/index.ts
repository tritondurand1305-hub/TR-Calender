/**
 * Public entry point for event normalisation.
 *
 * Phase 1 exposes one deterministic provider (`rules-v1`) behind a
 * provider-neutral asynchronous interface. Nothing here touches the database,
 * the network, the filesystem or the clock: callers must pass the submission
 * timestamp as `referenceTime`.
 *
 * Failure policy: normalisation never throws across this boundary for ordinary
 * JSON-shaped input. Invalid input, provider errors, invalid provider output
 * and cancellation all return a `NormalizationResult` with `draft: null` and a
 * fixed, safe message. Raw submission values are never copied into errors or
 * flags.
 *
 * Cancellation: an already-aborted signal stops the wrapper before any work.
 * After the provider resolves (or throws), an aborted signal discards whatever
 * it returned and yields `status: "cancelled"`. JavaScript cannot forcibly
 * interrupt a running provider, so providers must also observe the signal;
 * the wrapper can only guarantee that a cancelled result is never returned as
 * a successful draft.
 */

import { rulesNormalizer } from "./rules.ts";
import {
  NORMALIZER_VERSION,
  parseNormalizerInput,
  toIsoReferenceTime,
  validateDraft,
} from "./types.ts";
import type {
  NormalizationErrorCode,
  NormalizationOptions,
  NormalizationResult,
  NormalizerProvider,
} from "./types.ts";

export * from "./types.ts";
export { rulesNormalizer } from "./rules.ts";

function failureResult(
  status: "invalid_input" | "failed" | "cancelled",
  code: NormalizationErrorCode,
  message: string,
  normalizerVersion: string,
  referenceTime: string | null,
): NormalizationResult {
  return {
    status,
    draft: null,
    reviewFlags: [],
    error: { code, message },
    normalizerVersion,
    referenceTime,
  };
}

/**
 * Run any provider and enforce the output contract.
 *
 * A provider that throws, returns malformed data or returns a draft with an
 * internal inconsistency produces `status: "failed"` and `draft: null`. An
 * invalid draft is never returned as if it were valid.
 */
export async function runNormalization(
  provider: NormalizerProvider,
  rawInput: unknown,
  options: NormalizationOptions,
): Promise<NormalizationResult> {
  const version =
    typeof provider?.version === "string" ? provider.version : NORMALIZER_VERSION;

  const signal = options ? options.signal : undefined;
  if (signal?.aborted) {
    return failureResult(
      "cancelled",
      "cancelled",
      "Normalization was cancelled before it started.",
      version,
      null,
    );
  }

  const suppliedReferenceTime = options ? options.referenceTime : undefined;
  const referenceTime =
    suppliedReferenceTime === undefined ? null : toIsoReferenceTime(suppliedReferenceTime);
  if (referenceTime === null) {
    return failureResult(
      "invalid_input",
      "invalid_input",
      "A valid reference time is required.",
      version,
      null,
    );
  }

  const parsed = parseNormalizerInput(rawInput);
  if (!parsed.ok) {
    return failureResult("invalid_input", "invalid_input", parsed.message, version, referenceTime);
  }

  let value: unknown;
  try {
    value = await provider.normalize(parsed.input, {
      referenceTime,
      signal,
    });
  } catch {
    if (signal?.aborted) {
      return failureResult(
        "cancelled",
        "cancelled",
        "Normalization was cancelled.",
        version,
        referenceTime,
      );
    }
    // The error object is intentionally discarded: it may contain submitted
    // values, credentials or stack traces.
    return failureResult(
      "failed",
      "internal_error",
      "The normalizer did not complete.",
      version,
      referenceTime,
    );
  }

  if (signal?.aborted) {
    return failureResult(
      "cancelled",
      "cancelled",
      "Normalization was cancelled.",
      version,
      referenceTime,
    );
  }

  const validation = validateDraft(value);
  if (!validation.ok) {
    return failureResult(
      "failed",
      "invalid_provider_output",
      "The normalizer produced a draft that failed validation.",
      version,
      referenceTime,
    );
  }

  const draft = validation.draft;
  return {
    status: draft.reviewFlags.length > 0 ? "needs_review" : "normalized",
    draft,
    reviewFlags: draft.reviewFlags,
    error: null,
    normalizerVersion: version,
    referenceTime,
  };
}

/**
 * Normalise a submission-shaped object with the deterministic provider.
 *
 * `referenceTime` is normally the submission's `createdAt`. It is echoed in
 * the result's `referenceTime`; Phase 1 does not derive dates from it, and it
 * is not a wall-clock production time.
 */
export async function normalizeEvent(
  rawInput: unknown,
  options: NormalizationOptions,
): Promise<NormalizationResult> {
  return runNormalization(rulesNormalizer, rawInput, options);
}
