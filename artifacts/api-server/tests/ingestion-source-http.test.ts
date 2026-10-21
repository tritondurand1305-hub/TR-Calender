/**
 * End-to-end test of the retrieval boundary over real HTTP.
 *
 * A local `node:http` server serves the synthetic fixtures, and the adapter is
 * pointed at it with `createVisitTumblerRidgeSource(url)`. That exercises the
 * real `fetch`, redirect handling, content-type and size checks, the parser and
 * the mapper together — everything except the database.
 *
 * It still does NOT touch visittumblerridge.ca: this environment has no
 * outbound internet access, and this test does not pretend otherwise. Its
 * purpose is to prove the code path that will run on a network-enabled host.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { previewIngestion } from "../src/ingestion/run.ts";
import {
  createVisitTumblerRidgeSource,
  inspectPage,
} from "../src/ingestion/visitTumblerRidge.ts";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "visit-tumbler-ridge",
);

async function fixture(name: string): Promise<string> {
  return readFile(path.join(fixtureDir, name), "utf8");
}

let server: Server;
let baseUrl: string;

before(async () => {
  const [listing, ics, feed] = await Promise.all([
    fixture("listing-relative.html"),
    fixture("event.ics"),
    fixture("feed.ics"),
  ]);

  server = createServer((request, response) => {
    const routes: Record<string, { body: string; type: string; status?: number; location?: string }> = {
      "/events": { body: "", type: "text/html", status: 302, location: "/events.html" },
      "/events.html": { body: listing, type: "text/html; charset=utf-8" },
      "/events/winter-storytime.ics": { body: ics, type: "text/calendar" },
      "/events/all.ics": { body: feed, type: "text/calendar" },
    };
    const route = routes[request.url ?? ""];
    if (!route) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(route.status ?? 200, {
      "content-type": route.type,
      ...(route.location ? { location: route.location } : {}),
    });
    response.end(route.body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("real HTTP retrieval against a local server", () => {
  it("follows a redirect, fetches the per-event ICS files and previews the import", async () => {
    const source = createVisitTumblerRidgeSource(`${baseUrl}/events`);
    const preview = await previewIngestion({
      source,
      fetch: globalThis.fetch,
      now: () => new Date("2026-01-10T12:00:00Z"),
    });

    assert.equal(preview.pageUrl, `${baseUrl}/events.html`, "the redirect should be followed");
    assert.deepEqual(preview.counts, { discovered: 5, ready: 4, held: 1 });

    const ready = preview.items.filter((item) => item.outcome === "ready");
    assert.deepEqual(
      ready.map((item) => item.title).sort(),
      ["Council Open House", "Library Closed — Staff Training", "Seniors' Tea & Social", "Winter Storytime"],
    );

    const held = preview.items.find((item) => item.outcome === "held");
    assert.equal(held?.reason, "ics_multiple_events");
  });

  it("reports the same structure through inspectPage", async () => {
    const source = createVisitTumblerRidgeSource(`${baseUrl}/events`);
    const page = await source.fetchListing({ fetch: globalThis.fetch, policy: {}, now: () => new Date() });
    const inspection = inspectPage(page);

    assert.equal(inspection.structuredEvents, 2);
    assert.equal(inspection.googleCalendarLinks, 2);
    assert.equal(inspection.icsLinks, 2);
    assert.deepEqual(inspection.feedHints, [`${baseUrl}/events/all.ics`]);
  });

  it("surfaces an HTTP failure as a typed fetch error, not an empty page", async () => {
    const source = createVisitTumblerRidgeSource(`${baseUrl}/missing`);
    await assert.rejects(
      () => previewIngestion({ source, fetch: globalThis.fetch }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "SourceFetchError" &&
        (error as { code?: string }).code === "http_error",
    );
  });
});
