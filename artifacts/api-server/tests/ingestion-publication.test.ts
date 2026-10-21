/**
 * The last link between an import and the public board: the response
 * serializer used by GET /events and GET /events/:slug.
 *
 * The public query itself is SQL (`status in ('published','cancelled')`) and
 * cannot be exercised without a database, so this test covers what can be
 * covered here:
 *
 *  - an imported, published row satisfies the generated public contract;
 *  - the source attribution reaches the public payload;
 *  - the internal provenance columns do not.
 *
 * The serializer is exported from the real route module, bundled with esbuild
 * because the API server imports without file extensions. No database is
 * contacted: a syntactically valid but unreachable DATABASE_URL is set so an
 * accidental connection would fail immediately rather than reach anything.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GetEventResponse, ListEventsResponse } from "../../../lib/api-zod/src/generated/api.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "..", "..");
const bundleDirectory = path.join(packageRoot, "node_modules", ".events-route-test");
const bundlePath = path.join(bundleDirectory, "events-route.mjs");

type EventRow = Record<string, unknown> & {
  startAt: Date;
  endAt: Date | null;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

let serializeEvent: (row: EventRow) => unknown;

before(async () => {
  const { build } = await import("esbuild");
  await mkdir(bundleDirectory, { recursive: true });
  await build({
    entryPoints: [path.join(packageRoot, "src", "routes", "events.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    external: [
      "express",
      "pg-native",
      "@google-cloud/storage",
      "@clerk/express",
      "@clerk/shared",
      "pino",
      "pino-http",
      "cookie-parser",
    ],
    alias: {
      "@workspace/db": path.join(repositoryRoot, "lib", "db", "src", "index.ts"),
      "@workspace/api-zod": path.join(repositoryRoot, "lib", "api-zod", "src", "index.ts"),
    },
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module";\nglobalThis.require = __createRequire(import.meta.url);',
    },
    outfile: bundlePath,
    logLevel: "silent",
  });

  process.env.DATABASE_URL = "postgres://user:password@127.0.0.1:5432/events-route-test";

  const module = (await import(bundlePath)) as { eventResponse?: (row: EventRow) => unknown };
  assert.equal(typeof module.eventResponse, "function", "eventResponse is not exported");
  serializeEvent = module.eventResponse as (row: EventRow) => unknown;
});

after(async () => {
  await rm(bundleDirectory, { recursive: true, force: true });
});

function importedRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "winter-storytime-a1b2c3",
    title: "Winter Storytime",
    summary: null,
    description: "Stories and songs for ages 0-5.",
    category: "Community Events",
    startAt: new Date("2026-01-20T18:30:00.000Z"),
    endAt: new Date("2026-01-20T19:30:00.000Z"),
    allDay: false,
    location: "Tumbler Ridge Public Library",
    sourceUrl: "https://www.visittumblerridge.ca/events/winter-storytime",
    organizer: null,
    contact: null,
    cost: null,
    registrationUrl: null,
    tags: [],
    status: "published",
    isDemo: false,
    lastVerifiedAt: new Date("2026-01-02T12:00:00.000Z"),
    sourceKey: "visit-tumbler-ridge",
    externalId: "ics:uid:winter-storytime-2026-01-20@visittumblerridge.ca",
    sourceName: "Visit Tumbler Ridge",
    sourceContentHash: "a".repeat(64),
    createdAt: new Date("2026-01-02T12:00:00.000Z"),
    updatedAt: new Date("2026-01-02T12:00:00.000Z"),
    ...overrides,
  };
}

describe("public event contract for an imported event", () => {
  it("serialises an imported published event into a valid public response", () => {
    const payload = serializeEvent(importedRow());
    const parsed = GetEventResponse.parse(payload);

    assert.equal(parsed.title, "Winter Storytime");
    assert.equal(parsed.sourceName, "Visit Tumbler Ridge");
    assert.equal(parsed.sourceUrl, "https://www.visittumblerridge.ca/events/winter-storytime");
    assert.equal(parsed.startAt.toISOString(), "2026-01-20T18:30:00.000Z");
  });

  it("does not leak the internal provenance columns", () => {
    const parsed = serializeEvent(importedRow()) as Record<string, unknown>;
    for (const key of ["sourceKey", "externalId", "sourceContentHash"]) {
      assert.equal(key in parsed, false, `${key} must not reach the public payload`);
    }
  });

  it("still parses inside the list response used by the public board", () => {
    const payload = serializeEvent(importedRow());
    const parsed = ListEventsResponse.parse([payload]);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.sourceName, "Visit Tumbler Ridge");
  });

  it("keeps a draft import readable by the serializer without changing its status", () => {
    // Drafts are excluded by the public query, not by the serializer; this
    // pins the fact that the serializer never upgrades a status.
    const payload = serializeEvent(importedRow({ status: "draft" })) as Record<string, unknown>;
    assert.equal(payload.status, "draft");
  });

  it("omits attribution for an event that was not imported", () => {
    const payload = serializeEvent(
      importedRow({
        sourceKey: null,
        externalId: null,
        sourceName: null,
        sourceContentHash: null,
        sourceUrl: null,
      }),
    ) as Record<string, unknown>;
    assert.equal(payload.sourceName, null);
  });
});
