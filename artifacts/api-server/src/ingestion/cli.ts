/**
 * Command-line contract for the ingestion entry point.
 *
 * Kept free of I/O so the operator-facing behaviour — argument parsing,
 * configuration validation and exit codes — is unit-testable without a
 * network, a database or a child process. `ingest.ts` is the thin shell that
 * reads `process.argv`/`process.env`, calls into this module and prints.
 *
 * Exit codes are part of the operator contract and are documented in
 * docs/ingestion-visit-tumbler-ridge.md:
 *
 *   0  completed, at least one usable listing
 *   1  the source could not be retrieved or parsed
 *   2  configuration or usage error (nothing was fetched, or nothing could be)
 *   3  the source was read but produced no usable listing
 *
 * The distinction between 1 and 3 matters during verification: 1 means "the
 * page is unreachable or is not a listing page", 3 means "the page loaded and
 * was understood as HTML, but the adapter found nothing it can import".
 */

import { VISIT_TUMBLER_RIDGE_EVENTS_URL, VISIT_TUMBLER_RIDGE_KEY } from "./visitTumblerRidge.ts";
import { DEFAULT_FETCH_POLICY, SourceFetchError } from "./http.ts";
import { SourceParseError } from "./types.ts";
import type { IngestionRunSummary } from "./run.ts";

export type CliMode = "run" | "preview" | "inspect";

export interface CliConfig {
  mode: CliMode;
  sourceKey: string;
  sourceUrl: string;
  pretty: boolean;
  userAgent: string;
}

export type CliErrorCategory = "usage" | "configuration";

export interface CliError {
  category: CliErrorCategory;
  /** Stable machine-readable code, safe to log. */
  code: string;
  /** Operator-facing sentence. Never contains a secret value. */
  message: string;
}

export type CliParseResult =
  | { kind: "help" }
  | { kind: "ready"; config: CliConfig }
  | { kind: "error"; error: CliError };

export const EXIT_OK = 0;
export const EXIT_SOURCE_FAILED = 1;
export const EXIT_CONFIGURATION = 2;
export const EXIT_NO_USABLE_LISTINGS = 3;

export type Env = Record<string, string | undefined>;

function usageError(code: string, message: string): CliParseResult {
  return { kind: "error", error: { category: "usage", code, message } };
}

function configurationError(code: string, message: string): CliParseResult {
  return { kind: "error", error: { category: "configuration", code, message } };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseCli(argv: readonly string[], env: Env): CliParseResult {
  let mode: CliMode = "run";
  let sourceKey = VISIT_TUMBLER_RIDGE_KEY;
  let sourceUrl = env.INGESTION_SOURCE_URL?.trim() || VISIT_TUMBLER_RIDGE_EVENTS_URL;
  let pretty = false;

  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") return { kind: "help" };
    else if (argument === "--dry-run" || argument === "--preview") mode = "preview";
    else if (argument === "--inspect") mode = "inspect";
    else if (argument === "--pretty") pretty = true;
    else if (argument.startsWith("--source=")) sourceKey = argument.slice("--source=".length);
    else if (argument.startsWith("--source-url=")) {
      sourceUrl = argument.slice("--source-url=".length);
    } else {
      // The argument is echoed only when it is a flag name, never a value,
      // so a mistyped secret cannot end up in a log line.
      return usageError(
        "unknown_argument",
        argument.startsWith("-")
          ? `Unknown option: ${argument.split("=")[0]}`
          : "Unexpected positional argument",
      );
    }
  }

  if (sourceKey !== VISIT_TUMBLER_RIDGE_KEY) {
    return configurationError(
      "unknown_source",
      `Unknown source "${sourceKey}". The only implemented source is ${VISIT_TUMBLER_RIDGE_KEY}.`,
    );
  }

  if (!isHttpUrl(sourceUrl)) {
    // Deliberately not echoing the value: a mirror URL may carry a token.
    return configurationError(
      "invalid_source_url",
      "The source URL must be an absolute http or https URL (set by --source-url or INGESTION_SOURCE_URL).",
    );
  }

  if (mode === "run" && !env.DATABASE_URL?.trim()) {
    // A run writes; inspection and dry-run do not and must stay usable with no
    // credential at hand.
    return configurationError(
      "missing_database_url",
      "DATABASE_URL must be set to run an import. Use --inspect or --dry-run to verify the source without a database.",
    );
  }

  return {
    kind: "ready",
    config: {
      mode,
      sourceKey,
      sourceUrl,
      pretty,
      userAgent: env.INGESTION_USER_AGENT?.trim() || DEFAULT_FETCH_POLICY.userAgent,
    },
  };
}

/** A dry run is only "successful" if it mapped at least one listing. */
export function exitCodeForPreview(preview: {
  counts: { discovered: number; ready: number; held: number };
}): number {
  return preview.counts.ready > 0 ? EXIT_OK : EXIT_NO_USABLE_LISTINGS;
}

/**
 * A run that imported, updated or re-verified nothing produced no usable
 * listing: the source loaded, but nothing in it could be published later.
 */
export function exitCodeForRun(summary: IngestionRunSummary): number {
  if (summary.outcome === "failed") return EXIT_SOURCE_FAILED;
  const handled =
    summary.counts.imported + summary.counts.updated + summary.counts.unchanged;
  return handled > 0 ? EXIT_OK : EXIT_NO_USABLE_LISTINGS;
}

/** Inspection is useful only if the adapter recognised at least one candidate. */
export function exitCodeForInspect(candidateCount: number): number {
  return candidateCount > 0 ? EXIT_OK : EXIT_NO_USABLE_LISTINGS;
}

export interface ErrorReport {
  category: CliErrorCategory | "source";
  code: string;
  message: string;
  exitCode: number;
}

/**
 * Classify a thrown error. `detail` is the error message, which PostgreSQL and
 * fetch produce without credentials; it is never a connection string.
 */
export function describeError(error: unknown): ErrorReport {
  if (error instanceof SourceFetchError) {
    return {
      category: "source",
      code: `fetch_${error.code}`,
      message: error.message,
      exitCode: EXIT_SOURCE_FAILED,
    };
  }
  if (error instanceof SourceParseError) {
    return {
      category: "source",
      code: `parse_${error.code}`,
      message: error.message,
      exitCode: EXIT_SOURCE_FAILED,
    };
  }
  return {
    category: "configuration",
    code: "runtime_error",
    message: error instanceof Error ? error.message : "Unexpected failure",
    exitCode: EXIT_CONFIGURATION,
  };
}
