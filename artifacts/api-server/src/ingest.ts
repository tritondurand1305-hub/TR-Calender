/**
 * Ingestion entry point.
 *
 *   node dist/ingest.mjs --inspect                 read the live page, print
 *                                                  structure counts, write nothing
 *   node dist/ingest.mjs --dry-run                 fetch, parse, map, print the
 *                                                  result — no database needed
 *   node dist/ingest.mjs                           run against the database
 *
 * `--inspect` and `--dry-run` never import `@workspace/db`, so they work with
 * no database and no credential. They are the supported way to verify a live
 * source before allowing it to write.
 *
 * Argument parsing, configuration validation and exit codes live in
 * `./ingestion/cli.ts` so they can be tested without a process, a network or a
 * database.
 *
 * Scheduling: this process is the polling entry point. Run it from the
 * deployment's scheduler (see docs/ingestion-visit-tumbler-ridge.md); the API
 * server itself does not start timers, and the Replit autoscale deployment has
 * no background worker.
 */

import {
  EXIT_CONFIGURATION,
  EXIT_OK,
  describeError,
  exitCodeForInspect,
  exitCodeForPreview,
  exitCodeForRun,
  parseCli,
  type CliConfig,
} from "./ingestion/cli.ts";
import { previewIngestion, runIngestion } from "./ingestion/run.ts";
import {
  createVisitTumblerRidgeSource,
  inspectPage,
  VISIT_TUMBLER_RIDGE_KEY,
} from "./ingestion/visitTumblerRidge.ts";
import type { FetchLike } from "./ingestion/http.ts";

function printUsage(): void {
  console.log(`Usage: node dist/ingest.mjs [--inspect | --dry-run] [--pretty] [--source=${VISIT_TUMBLER_RIDGE_KEY}] [--source-url=<url>]

  (no mode)   run the import and persist results (requires DATABASE_URL)
  --dry-run   fetch, parse and map, then print what would happen. Writes
              nothing and needs no database.
  --inspect   fetch the page and print structure counts only. Writes nothing.
  --pretty    indent the JSON output
  --source    source key (only ${VISIT_TUMBLER_RIDGE_KEY} is implemented)
  --source-url override the listing URL (also INGESTION_SOURCE_URL); used for
               a staging mirror or a local end-to-end check

Environment: DATABASE_URL (run only), INGESTION_SOURCE_URL, INGESTION_USER_AGENT.

Exit codes:
  0  completed; at least one listing was mapped (or imported/updated/verified)
  1  the source could not be retrieved or parsed
  2  configuration or usage error; nothing was written
  3  the source was read but yielded no usable listing (check the page structure)`);
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

async function execute(config: CliConfig): Promise<number> {
  const fetchImpl = globalThis.fetch as unknown as FetchLike;
  const policy = { userAgent: config.userAgent };
  const source = createVisitTumblerRidgeSource(config.sourceUrl);

  if (config.mode === "inspect") {
    const page = await source.fetchListing({
      fetch: fetchImpl,
      policy,
      now: () => new Date(),
    });
    // `extractCandidates` throws SourceParseError when the document has no
    // links and no structured data at all; that surfaces as exit 1. A document
    // that parses but yields no listing is the different, quieter failure:
    // exit 3.
    const candidates = source.extractCandidates(page);
    output(
      {
        mode: "inspect",
        sourceUrl: page.url,
        page: { ...inspectPage(page), candidates: candidates.length },
      },
      config.pretty,
    );
    return exitCodeForInspect(candidates.length);
  }

  if (config.mode === "preview") {
    const preview = await previewIngestion({
      source,
      fetch: fetchImpl,
      policy,
    });
    output({ mode: "preview", preview }, config.pretty);
    return exitCodeForPreview(preview);
  }

  // The database module throws on import without DATABASE_URL; `parseCli` has
  // already rejected a run in that case. Importing it here, only for a real
  // run, keeps --inspect and --dry-run usable without a database.
  const { createDrizzleIngestionStore } = await import("./ingestion/drizzleStore.ts");
  const summary = await runIngestion({
    source,
    fetch: fetchImpl,
    policy,
    store: createDrizzleIngestionStore(),
    logger: logger(),
  });
  output({ mode: "run", summary }, config.pretty);
  return exitCodeForRun(summary);
}

async function main(): Promise<number> {
  const parsed = parseCli(process.argv.slice(2), process.env);

  if (parsed.kind === "help") {
    printUsage();
    return EXIT_OK;
  }

  if (parsed.kind === "error") {
    // Errors go to stdout as JSON so a verification step that captures only
    // stdout still sees why the command stopped. The message never contains a
    // credential.
    output({ mode: "error", ...parsed.error, exitCode: EXIT_CONFIGURATION }, false);
    return EXIT_CONFIGURATION;
  }

  try {
    return await execute(parsed.config);
  } catch (error) {
    const report = describeError(error);
    console.error(
      JSON.stringify({
        level: "error",
        message: "Ingestion entry point failed",
        category: report.category,
        code: report.code,
        detail: report.message,
      }),
    );
    return report.exitCode;
  }
}

void main().then((code) => {
  process.exitCode = code;
});
