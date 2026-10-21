/**
 * Ingestion entry point.
 *
 *   node dist/ingest.mjs --inspect                 read the live page, print
 *                                                  structure counts, write nothing
 *   node dist/ingest.mjs --dry-run                 fetch, parse, map, print the
 *                                                  result — no database needed
 *   node dist/ingest.mjs                           run against the database
 *
 * The dry-run and inspect modes never import `@workspace/db`, so they work in
 * an environment without `DATABASE_URL` and are the supported way to verify a
 * live source before allowing it to write.
 *
 * Scheduling: this process is the polling entry point. Run it from the
 * deployment's scheduler (see docs/ingestion-visit-tumbler-ridge.md); the API
 * server itself does not start timers, and the Replit autoscale deployment has
 * no background worker.
 */

import { failureCode, previewIngestion, runIngestion } from "./ingestion/run.ts";
import {
  createVisitTumblerRidgeSource,
  inspectPage,
  VISIT_TUMBLER_RIDGE_EVENTS_URL,
  VISIT_TUMBLER_RIDGE_KEY,
} from "./ingestion/visitTumblerRidge.ts";
import { DEFAULT_FETCH_POLICY, SourceFetchError, type FetchLike } from "./ingestion/http.ts";
import { SourceParseError } from "./ingestion/types.ts";

type Mode = "run" | "preview" | "inspect";

interface Options {
  mode: Mode;
  source: string;
  sourceUrl: string;
  pretty: boolean;
}

function parseArguments(argv: string[]): Options {
  let mode: Mode = "run";
  let source = VISIT_TUMBLER_RIDGE_KEY;
  let sourceUrl = process.env.INGESTION_SOURCE_URL ?? VISIT_TUMBLER_RIDGE_EVENTS_URL;
  let pretty = false;

  for (const argument of argv) {
    if (argument === "--dry-run" || argument === "--preview") mode = "preview";
    else if (argument === "--inspect") mode = "inspect";
    else if (argument === "--pretty") pretty = true;
    else if (argument.startsWith("--source=")) source = argument.slice("--source=".length);
    else if (argument.startsWith("--source-url=")) sourceUrl = argument.slice("--source-url=".length);
    else if (argument === "--help" || argument === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return { mode, source, sourceUrl, pretty };
}

function printUsage(): void {
  console.log(`Usage: node dist/ingest.mjs [--inspect | --dry-run] [--pretty] [--source=${VISIT_TUMBLER_RIDGE_KEY}] [--source-url=<url>]

  (no mode)   run the import and persist results
  --dry-run   fetch and parse, print what would happen, persist nothing
  --inspect   fetch the page and print structure counts only
  --pretty    indent the JSON output
  --source    source key (only ${VISIT_TUMBLER_RIDGE_KEY} is implemented)
  --source-url override the listing URL (also INGESTION_SOURCE_URL); used for
               a staging mirror or a local end-to-end check

Exit codes: 0 ok/partial, 1 failed, 2 configuration or usage error.`);
}

function output(value: unknown, pretty: boolean): void {
  console.log(pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
}

function logger() {
  return {
    info: (context: Record<string, unknown>, message: string) =>
      console.error(JSON.stringify({ level: "info", message, ...context })),
    warn: (context: Record<string, unknown>, message: string) =>
      console.error(JSON.stringify({ level: "warn", message, ...context })),
    error: (context: Record<string, unknown>, message: string) =>
      console.error(JSON.stringify({ level: "error", message, ...context })),
  };
}

async function main(): Promise<number> {
  const options = parseArguments(process.argv.slice(2));
  if (options.source !== VISIT_TUMBLER_RIDGE_KEY) {
    output({ error: `Unknown source: ${options.source}` }, options.pretty);
    return 2;
  }

  const fetchImpl = globalThis.fetch as unknown as FetchLike;
  const policy = { userAgent: process.env.INGESTION_USER_AGENT ?? DEFAULT_FETCH_POLICY.userAgent };
  const source = createVisitTumblerRidgeSource(options.sourceUrl);

  if (options.mode === "inspect") {
    const page = await source.fetchListing({
      fetch: fetchImpl,
      policy,
      now: () => new Date(),
    });
    output({ mode: "inspect", sourceUrl: page.url, page: inspectPage(page) }, options.pretty);
    return 0;
  }

  if (options.mode === "preview") {
    const preview = await previewIngestion({
      source,
      fetch: fetchImpl,
      policy,
      logger: logger(),
    });
    output({ mode: "preview", preview }, options.pretty);
    return 0;
  }

  // The database module throws on import without DATABASE_URL. Importing it
  // here, only for a real run, keeps --inspect and --dry-run usable without a
  // database or any credential.
  const { createDrizzleIngestionStore } = await import("./ingestion/drizzleStore");
  const summary = await runIngestion({
    source,
    fetch: fetchImpl,
    policy,
    store: createDrizzleIngestionStore(),
    logger: logger(),
  });
  output({ mode: "run", summary }, options.pretty);
  return summary.outcome === "failed" ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Ingestion entry point failed",
        errorCode: failureCode(error),
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    // A source that cannot be read is an operational failure (1); an unknown
    // argument or a missing database is a configuration problem (2).
    process.exitCode =
      error instanceof SourceFetchError || error instanceof SourceParseError ? 1 : 2;
  });
