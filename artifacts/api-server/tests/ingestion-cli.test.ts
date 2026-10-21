/**
 * Tests for the operator-facing CLI contract: argument parsing, configuration
 * validation and exit codes.
 *
 * These run the pure module directly — no process, no network, no database.
 * They exist because the exit code and the error category are how an operator
 * distinguishes "the source is down" from "the page changed" from "I forgot to
 * set DATABASE_URL", and that distinction is worth pinning down.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EXIT_CONFIGURATION,
  EXIT_NO_USABLE_LISTINGS,
  EXIT_OK,
  EXIT_SOURCE_FAILED,
  describeError,
  exitCodeForInspect,
  exitCodeForPreview,
  exitCodeForRun,
  parseCli,
  type CliConfig,
} from "../src/ingestion/cli.ts";
import { SourceFetchError } from "../src/ingestion/http.ts";
import { SourceParseError } from "../src/ingestion/types.ts";
import type { IngestionRunSummary } from "../src/ingestion/run.ts";
import { VISIT_TUMBLER_RIDGE_EVENTS_URL } from "../src/ingestion/visitTumblerRidge.ts";

const DATABASE_URL = "postgres://user:password@127.0.0.1:5432/unused";

function ready(result: ReturnType<typeof parseCli>): CliConfig {
  assert.equal(result.kind, "ready", `expected a ready config, got ${JSON.stringify(result)}`);
  return (result as { kind: "ready"; config: CliConfig }).config;
}

function errorOf(result: ReturnType<typeof parseCli>) {
  assert.equal(result.kind, "error", `expected an error, got ${JSON.stringify(result)}`);
  return (result as { kind: "error"; error: { category: string; code: string; message: string } })
    .error;
}

describe("argument parsing", () => {
  it("defaults to a run against the Visit Tumbler Ridge events page", () => {
    const config = ready(parseCli([], { DATABASE_URL }));
    assert.equal(config.mode, "run");
    assert.equal(config.sourceKey, "visit-tumbler-ridge");
    assert.equal(config.sourceUrl, VISIT_TUMBLER_RIDGE_EVENTS_URL);
    assert.equal(config.pretty, false);
  });

  it("understands --inspect, --dry-run and its --preview alias", () => {
    assert.equal(ready(parseCli(["--inspect"], {})).mode, "inspect");
    assert.equal(ready(parseCli(["--dry-run"], {})).mode, "preview");
    assert.equal(ready(parseCli(["--preview"], {})).mode, "preview");
    // The last mode flag wins, so a copied command can be corrected by appending.
    assert.equal(ready(parseCli(["--inspect", "--dry-run"], {})).mode, "preview");
  });

  it("honours --pretty and the source URL overrides", () => {
    const config = ready(
      parseCli(["--dry-run", "--pretty", "--source-url=https://mirror.test/events"], {}),
    );
    assert.equal(config.pretty, true);
    assert.equal(config.sourceUrl, "https://mirror.test/events");

    const fromEnv = ready(
      parseCli(["--dry-run"], { INGESTION_SOURCE_URL: "https://mirror.test/from-env" }),
    );
    assert.equal(fromEnv.sourceUrl, "https://mirror.test/from-env");

    const flagWins = ready(
      parseCli(["--dry-run", "--source-url=https://mirror.test/flag"], {
        INGESTION_SOURCE_URL: "https://mirror.test/env",
      }),
    );
    assert.equal(flagWins.sourceUrl, "https://mirror.test/flag");
  });

  it("uses INGESTION_USER_AGENT when set", () => {
    const config = ready(parseCli(["--dry-run"], { INGESTION_USER_AGENT: "TRBot/2.0 (ops@test)" }));
    assert.equal(config.userAgent, "TRBot/2.0 (ops@test)");
    assert.match(ready(parseCli(["--dry-run"], {})).userAgent, /TRCalendarBot/);
  });

  it("returns help for --help and -h", () => {
    assert.equal(parseCli(["--help"], {}).kind, "help");
    assert.equal(parseCli(["-h"], {}).kind, "help");
  });
});

describe("configuration validation", () => {
  it("rejects an unknown option with a usage error", () => {
    const error = errorOf(parseCli(["--dryrun"], { DATABASE_URL }));
    assert.equal(error.category, "usage");
    assert.equal(error.code, "unknown_argument");
    assert.match(error.message, /--dryrun/);
  });

  it("never echoes the value of an unrecognised argument", () => {
    const error = errorOf(parseCli(["--token=super-secret-value"], { DATABASE_URL }));
    assert.equal(error.code, "unknown_argument");
    assert.equal(error.message.includes("super-secret-value"), false);
  });

  it("rejects an unknown source", () => {
    const error = errorOf(parseCli(["--source=district"], { DATABASE_URL }));
    assert.equal(error.category, "configuration");
    assert.equal(error.code, "unknown_source");
    assert.match(error.message, /visit-tumbler-ridge/);
  });

  it("rejects a source URL that is not absolute http(s)", () => {
    for (const value of ["ftp://example.test/events", "example.test/events", "not a url"]) {
      const error = errorOf(parseCli([`--source-url=${value}`, "--dry-run"], {}));
      assert.equal(error.code, "invalid_source_url", `for ${value}`);
      assert.equal(error.message.includes(value), false, "the URL value is not echoed");
    }
    assert.equal(ready(parseCli(["--source-url=http://127.0.0.1:8123/events", "--dry-run"], {})).mode, "preview");
  });

  it("requires DATABASE_URL for a run and says what to use instead", () => {
    const error = errorOf(parseCli([], {}));
    assert.equal(error.category, "configuration");
    assert.equal(error.code, "missing_database_url");
    assert.match(error.message, /--inspect or --dry-run/);
  });

  it("treats a blank DATABASE_URL as missing", () => {
    assert.equal(errorOf(parseCli([], { DATABASE_URL: "   " })).code, "missing_database_url");
  });

  it("never echoes the database URL in an error", () => {
    const error = errorOf(parseCli([], { DATABASE_URL: "  " }));
    assert.equal(error.message.includes("postgres://"), false);
    assert.equal(error.message.includes("password"), false);
  });

  it("allows inspection and dry-run with no database configured", () => {
    assert.equal(ready(parseCli(["--inspect"], {})).mode, "inspect");
    assert.equal(ready(parseCli(["--dry-run"], {})).mode, "preview");
  });

  it("allows a run when the database URL is present", () => {
    assert.equal(ready(parseCli([], { DATABASE_URL })).mode, "run");
  });
});

describe("exit codes", () => {
  it("maps a dry run by whether anything was usable", () => {
    assert.equal(exitCodeForPreview({ counts: { discovered: 5, ready: 4, held: 1 } }), EXIT_OK);
    assert.equal(
      exitCodeForPreview({ counts: { discovered: 3, ready: 0, held: 3 } }),
      EXIT_NO_USABLE_LISTINGS,
    );
    assert.equal(
      exitCodeForPreview({ counts: { discovered: 0, ready: 0, held: 0 } }),
      EXIT_NO_USABLE_LISTINGS,
    );
  });

  it("maps a run by outcome and by whether anything was handled", () => {
    const summary = (overrides: Partial<IngestionRunSummary>): IngestionRunSummary => ({
      sourceKey: "visit-tumbler-ridge",
      sourceName: "Visit Tumbler Ridge",
      startedAt: "2026-01-02T12:00:00.000Z",
      finishedAt: "2026-01-02T12:00:01.000Z",
      outcome: "ok",
      errorCode: null,
      pageUrl: "https://example.test/events",
      counts: { discovered: 4, imported: 4, updated: 0, unchanged: 0, held: 0, errors: 0 },
      heldReasons: {},
      heldSamples: [],
      ...overrides,
    });

    assert.equal(exitCodeForRun(summary({})), EXIT_OK);
    assert.equal(
      exitCodeForRun(
        summary({ counts: { discovered: 4, imported: 0, updated: 0, unchanged: 4, held: 0, errors: 0 } }),
      ),
      EXIT_OK,
    );
    assert.equal(
      exitCodeForRun(
        summary({
          outcome: "partial",
          counts: { discovered: 2, imported: 0, updated: 0, unchanged: 0, held: 2, errors: 0 },
        }),
      ),
      EXIT_NO_USABLE_LISTINGS,
    );
    assert.equal(
      exitCodeForRun(summary({ outcome: "failed", errorCode: "fetch_network_error" })),
      EXIT_SOURCE_FAILED,
    );
  });

  it("maps inspection by the number of recognised candidates", () => {
    assert.equal(exitCodeForInspect(5), EXIT_OK);
    assert.equal(exitCodeForInspect(0), EXIT_NO_USABLE_LISTINGS);
  });

  it("classifies thrown errors as source or configuration failures", () => {
    const fetchFailure = describeError(new SourceFetchError("http_error", "Source responded 503", 503));
    assert.equal(fetchFailure.category, "source");
    assert.equal(fetchFailure.code, "fetch_http_error");
    assert.equal(fetchFailure.exitCode, EXIT_SOURCE_FAILED);

    const parseFailure = describeError(new SourceParseError("page_not_recognised", "no links"));
    assert.equal(parseFailure.category, "source");
    assert.equal(parseFailure.code, "parse_page_not_recognised");
    assert.equal(parseFailure.exitCode, EXIT_SOURCE_FAILED);

    const runtime = describeError(new Error("boom"));
    assert.equal(runtime.category, "configuration");
    assert.equal(runtime.exitCode, EXIT_CONFIGURATION);

    assert.equal(EXIT_CONFIGURATION, 2);
    assert.equal(EXIT_SOURCE_FAILED, 1);
    assert.equal(EXIT_NO_USABLE_LISTINGS, 3);
    assert.equal(EXIT_OK, 0);
  });
});
