/**
 * Public entry point for event normalisation.
 *
 * Phase 1 exposes one deterministic provider (`rules-v1`) behind a
 * provider-neutral asynchronous interface. Nothing here touches the database,
 * the network, the filesystem or the clock: callers must pass the submission
 * timestamp as `referenceTime`.
 *
 * Failure policy: normalisation never throws across this boundary. Invalid
 * input, provider errors and provider output that fails the contract all
 * return a `NormalizationResult` with `draft: null` and a fixed, safe message.
 * Raw submission values are never copied into errors or flags.
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
  status: "invalid_input" | "failed",
  code: NormalizationErrorCode,
  message: string,
  normalizerVersion: string,
  producedAt: string | null,
): NormalizationResult {
  return {
    status,
    draft: null,
    reviewFlags: [],
    error: { code, message },
    normalizerVersion,
    producedAt,
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

  const referenceTime = options ? options.referenceTime : undefined;
  const producedAt = referenceTime === undefined ? null : toIsoReferenceTime(referenceTime);
  if (producedAt === null) {
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
    return failureResult("invalid_input", "invalid_input", parsed.message, version, producedAt);
  }

  let value: unknown;
  try {
    value = await provider.normalize(parsed.input, {
      referenceTime: producedAt,
      signal: options ? options.signal : undefined,
    });
  } catch {
    // The error object is intentionally discarded: it may contain submitted
    // values, credentials or stack traces.
    return failureResult(
      "failed",
      "internal_error",
      "The normalizer did not complete.",
      version,
      producedAt,
    );
  }

  const validation = validateDraft(value);
  if (!validation.ok) {
    return failureResult(
      "failed",
      "invalid_provider_output",
      "The normalizer produced a draft that failed validation.",
      version,
      producedAt,
    );
  }

  const draft = validation.draft;
  return {
    status: draft.reviewFlags.length > 0 ? "needs_review" : "normalized",
    draft,
    reviewFlags: draft.reviewFlags,
    error: null,
    normalizerVersion: version,
    producedAt,
  };
}

/**
 * Normalise a submission-shaped object with the deterministic provider.
 *
 * `referenceTime` is normally the submission's `createdAt`. It is echoed in
 * `producedAt`; Phase 1 does not derive dates from it.
 */
export async function normalizeEvent(
  rawInput: unknown,
  options: NormalizationOptions,
): Promise<NormalizationResult> {
  return runNormalization(rulesNormalizer, rawInput, options);
}
