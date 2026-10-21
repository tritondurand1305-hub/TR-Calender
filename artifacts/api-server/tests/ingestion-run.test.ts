/**
 * Behavioural tests for the ingestion pipeline, including every case the task
 * requires: first import, duplicate ingestion, update, unchanged content,
 * invalid or missing identifiers, fetch failure, parsing failure, preservation
 * of existing events when a source fails, and protection of administrator-owned
 * fields and the review gate.
 *
 * The store is an in-memory implementation of the same interface the Drizzle
 * store implements. No database is contacted and no network request is made:
 * `fetch` is always a fake reading the synthetic fixtures.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { FetchLike } from "../src/ingestion/http.ts";
import { previewIngestion, runIngestion } from "../src/ingestion/run.ts";
import type {
  ImportedEventInsert,
  ImportedEventRef,
  ImportedEventUpdate,
  IngestionStore,
  ItemOutcomeRecord,
  SourceHealthSnapshot,
  SourceHealthUpdate,
} from "../src/ingestion/store.ts";
import {
  VISIT_TUMBLER_RIDGE_EVENTS_URL,
  visitTumblerRidgeSource,
} from "../src/ingestion/visitTumblerRidge.ts";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "visit-tumbler-ridge",
);

async function fixture(name: string): Promise<string> {
  return readFile(path.join(fixtureDir, name), "utf8");
}

interface MemoryEvent
  extends Omit<
    ImportedEventInsert,
    "summary" | "status" | "organizer" | "contact" | "cost" | "registrationUrl"
  > {
  id: string;
  slug: string;
  status: string;
  summary: string | null;
  organizer: string | null;
  contact: string | null;
  cost: string | null;
  registrationUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

class MemoryStore implements IngestionStore {
  readonly events: MemoryEvent[] = [];
  readonly sources = new Map<string, SourceHealthUpdate>();
  readonly items = new Map<string, ItemOutcomeRecord>();
  private sequence = 0;

  async loadSource(sourceKey: string): Promise<SourceHealthSnapshot | null> {
    const saved = this.sources.get(sourceKey);
    if (!saved) return null;
    return {
      sourceKey: saved.sourceKey,
      status: saved.status,
      lastAttemptAt: saved.attemptedAt,
      lastSuccessAt: saved.lastSuccessAt,
      lastFailureAt: saved.lastFailureAt,
      lastErrorCode: saved.lastErrorCode,
      consecutiveFailures: saved.consecutiveFailures,
      lastRunSummary: saved.lastRunSummary,
    };
  }

  async saveSource(update: SourceHealthUpdate): Promise<void> {
    this.sources.set(update.sourceKey, update);
  }

  async findEventByExternalId(
    sourceKey: string,
    externalId: string,
  ): Promise<ImportedEventRef | null> {
    const event = this.events.find(
      (candidate) => candidate.sourceKey === sourceKey && candidate.externalId === externalId,
    );
    return event ? this.ref(event) : null;
  }

  async findEventByTitleAndStart(
    sourceKey: string,
    title: string,
    startAt: Date,
  ): Promise<ImportedEventRef | null> {
    const event = this.events.find(
      (candidate) =>
        candidate.sourceKey === sourceKey &&
        candidate.title.toLocaleLowerCase("en-CA") === title.toLocaleLowerCase("en-CA") &&
        candidate.startAt.getTime() === startAt.getTime(),
    );
    return event ? this.ref(event) : null;
  }

  async insertEvent(values: ImportedEventInsert, slug: string): Promise<ImportedEventRef> {
    this.sequence += 1;
    const event: MemoryEvent = {
      ...values,
      id: `event-${this.sequence}`,
      slug,
      status: values.status,
      createdAt: new Date("2026-01-02T12:00:00.000Z"),
      updatedAt: new Date("2026-01-02T12:00:00.000Z"),
    };
    this.events.push(event);
    return this.ref(event);
  }

  async updateEvent(id: string, values: ImportedEventUpdate): Promise<void> {
    const event = this.events.find((candidate) => candidate.id === id);
    if (!event) throw new Error(`Missing event ${id}`);
    Object.assign(event, values, { updatedAt: new Date("2026-02-01T00:00:00.000Z") });
  }

  async markChecked(id: string, checkedAt: Date): Promise<void> {
    const event = this.events.find((candidate) => candidate.id === id);
    if (!event) throw new Error(`Missing event ${id}`);
    event.lastVerifiedAt = checkedAt;
  }

  async recordItem(record: ItemOutcomeRecord): Promise<void> {
    this.items.set(`${record.sourceKey}|${record.externalId}`, record);
  }

  private ref(event: MemoryEvent): ImportedEventRef {
    return {
      id: event.id,
      status: event.status,
      sourceContentHash: event.sourceContentHash,
    };
  }
}

interface Routes {
  page?: string;
  ics?: Record<string, string>;
  pageStatus?: number;
  throwOnPage?: boolean;
}

function makeFetch(routes: Routes): FetchLike {
  return async (url: string) => {
    if (url === VISIT_TUMBLER_RIDGE_EVENTS_URL) {
      if (routes.throwOnPage) throw new Error("ECONNRESET");
      const body = routes.page ?? (await fixture("listing.html"));
      return new Response(body, {
        status: routes.pageStatus ?? 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    const ics = routes.ics?.[url];
    if (!ics) return new Response("not found", { status: 404 });
    return new Response(ics, { headers: { "content-type": "text/calendar" } });
  };
}

async function defaultRoutes(overrides: Routes = {}): Promise<Routes> {
  return {
    page: overrides.page ?? (await fixture("listing.html")),
    ics: {
      "https://www.visittumblerridge.ca/events/winter-storytime.ics": await fixture("event.ics"),
      "https://www.visittumblerridge.ca/events/all.ics": await fixture("feed.ics"),
      ...(overrides.ics ?? {}),
    },
    ...overrides,
  };
}

// One shared clock across runs in this file: every read is one second later
// than the previous one, so successive runs are strictly ordered.
let clock = Date.UTC(2026, 0, 2, 12, 0, 0);

function run(store: IngestionStore, fetchImpl: FetchLike) {
  return runIngestion({
    source: visitTumblerRidgeSource,
    fetch: fetchImpl,
    store,
    now: () => new Date((clock += 1000)),
  });
}

describe("first import", () => {
  it("creates draft events for readable listings and holds the rest", async () => {
    const store = new MemoryStore();
    const summary = await run(store, makeFetch(await defaultRoutes()));

    assert.equal(summary.counts.discovered, 5);
    assert.equal(summary.counts.imported, 4);
    assert.equal(summary.counts.held, 1);
    assert.equal(summary.outcome, "partial");
    assert.equal(summary.errorCode, "items_held");

    assert.deepEqual(
      store.events.map((event) => event.title).sort(),
      ["Council Open House", "Library Closed — Staff Training", "Seniors' Tea & Social", "Winter Storytime"],
    );
    for (const event of store.events) {
      assert.equal(event.status, "draft", "ingestion must never publish");
      assert.equal(event.isDemo, false);
      assert.equal(event.category, "Community Events");
      assert.equal(event.sourceKey, "visit-tumbler-ridge");
      assert.equal(event.sourceName, "Visit Tumbler Ridge");
      assert.ok(event.slug.length > 0);
      assert.ok(event.sourceContentHash.length === 64);
    }

    // A multi-event file is held for a human decision, not partially imported.
    const held = [...store.items.values()].find((item) => item.outcome === "held");
    assert.ok(held);
    assert.equal(held.reasonCode, "ics_multiple_events");

    const health = store.sources.get("visit-tumbler-ridge");
    assert.ok(health);
    assert.equal(health.status, "partial");
    assert.equal(health.lastSuccessAt?.toISOString(), summary.finishedAt);
    assert.equal(health.consecutiveFailures, 0);
  });

  it("keeps the original source URL and attribution", async () => {
    const store = new MemoryStore();
    await run(store, makeFetch(await defaultRoutes()));
    const storytime = store.events.find((event) => event.title === "Winter Storytime");
    assert.ok(storytime);
    assert.equal(storytime.sourceUrl, "https://www.visittumblerridge.ca/events/winter-storytime");
    assert.equal(storytime.location, "Tumbler Ridge Public Library, 100 Founders Way");
  });

  it("reports what a preview would do without writing anything", async () => {
    const preview = await previewIngestion({
      source: visitTumblerRidgeSource,
      fetch: makeFetch(await defaultRoutes()),
    });
    assert.deepEqual(preview.counts, { discovered: 5, ready: 4, held: 1 });
    assert.equal(preview.pageUrl, VISIT_TUMBLER_RIDGE_EVENTS_URL);
    assert.ok(preview.items.some((item) => item.outcome === "ready" && item.title === "Council Open House"));
  });
});

describe("repeated imports", () => {
  it("does not duplicate an unchanged listing and only refreshes the check time", async () => {
    const store = new MemoryStore();
    await run(store, makeFetch(await defaultRoutes()));
    const before = store.events.map((event) => ({ ...event }));

    const summary = await run(store, makeFetch(await defaultRoutes()));

    assert.equal(store.events.length, before.length);
    assert.equal(summary.counts.imported, 0);
    assert.equal(summary.counts.unchanged, 4);
    assert.equal(summary.counts.updated, 0);

    for (const [index, event] of store.events.entries()) {
      const original = before[index];
      assert.ok(original);
      assert.equal(event.id, original.id);
      assert.equal(event.updatedAt.toISOString(), original.updatedAt.toISOString());
      assert.ok(
        event.lastVerifiedAt.getTime() > original.lastVerifiedAt.getTime(),
        "an unchanged listing is still verified",
      );
    }
  });

  it("updates the same listing when an ICS-backed event changes", async () => {
    const store = new MemoryStore();
    await run(store, makeFetch(await defaultRoutes()));
    const original = store.events.find((event) => event.title === "Winter Storytime");
    assert.ok(original);
    const originalId = original.id;
    const originalHash = original.sourceContentHash;
    const originalStart = original.startAt.toISOString();

    // Same UID, new time and description: the source edited the event.
    const edited = (await fixture("event.ics"))
      .replace("SUMMARY:Winter Storytime", "SUMMARY:Winter Storytime (new time)")
      .replace("DTSTART;TZID=America/Vancouver:20260120T103000", "DTSTART;TZID=America/Vancouver:20260120T110000")
      .replace("DTEND;TZID=America/Vancouver:20260120T113000", "DTEND;TZID=America/Vancouver:20260120T120000");

    const summary = await run(
      store,
      makeFetch(
        await defaultRoutes({
          ics: { "https://www.visittumblerridge.ca/events/winter-storytime.ics": edited },
        }),
      ),
    );

    assert.equal(summary.counts.updated, 1);
    assert.equal(summary.counts.imported, 0);
    assert.equal(store.events.length, 4);

    const updated = store.events.find((event) => event.id === originalId);
    assert.ok(updated);
    assert.equal(updated.title, "Winter Storytime (new time)");
    assert.equal(updated.startAt.toISOString(), "2026-01-20T19:00:00.000Z");
    assert.notEqual(updated.startAt.toISOString(), originalStart);
    assert.notEqual(updated.sourceContentHash, originalHash);
    assert.equal(updated.externalId, "ics:uid:winter-storytime-2026-01-20@visittumblerridge.ca");
  });

  it("preserves administrator-owned fields and the publication decision on update", async () => {
    const store = new MemoryStore();
    await run(store, makeFetch(await defaultRoutes()));
    const event = store.events.find((candidate) => candidate.title === "Winter Storytime");
    assert.ok(event);

    // What an administrator may have done after the first import.
    event.summary = "Hand-written summary";
    event.tags = ["library", "kids"];
    event.cost = "Free";
    event.contact = "library@example.ca";
    event.registrationUrl = "https://example.ca/register";
    event.organizer = "Tumbler Ridge Public Library";
    event.status = "published";

    const edited = (await fixture("event.ics")).replace(
      "Stories and songs for ages 0-5.",
      "Stories, songs and a craft for ages 0-5.",
    );
    const summary = await run(
      store,
      makeFetch(
        await defaultRoutes({
          ics: { "https://www.visittumblerridge.ca/events/winter-storytime.ics": edited },
        }),
      ),
    );

    assert.equal(summary.counts.updated, 1);
    const updated = store.events.find((candidate) => candidate.id === event.id);
    assert.ok(updated);
    assert.match(updated.description ?? "", /a craft/);
    assert.equal(updated.status, "published");
    assert.equal(updated.summary, "Hand-written summary");
    assert.deepEqual(updated.tags, ["library", "kids"]);
    assert.equal(updated.cost, "Free");
    assert.equal(updated.contact, "library@example.ca");
    assert.equal(updated.registrationUrl, "https://example.ca/register");
    assert.equal(updated.organizer, "Tumbler Ridge Public Library");
  });

  it("imports a changed Google Calendar-only listing as a new draft, never silently merging it", async () => {
    // Documented limitation: a Google Calendar template URL encodes the event
    // content, so a changed title produces a new identifier. Without a stable
    // source id there is nothing safe to match on, and guessing would risk
    // merging two different events. The result is a new draft a person reviews.
    const store = new MemoryStore();
    await run(store, makeFetch(await defaultRoutes()));
    const original = store.events.find((event) => event.title === "Council Open House");
    assert.ok(original);

    const page = (await fixture("listing.html"))
      .replace("Council Open House", "Council Open House and Budget Q&A")
      .replace("text=Council+Open+House", "text=Council+Open+House+and+Budget+Q%26A");
    const summary = await run(store, makeFetch(await defaultRoutes({ page })));

    assert.equal(summary.counts.imported, 1);
    assert.equal(summary.counts.updated, 0);
    const matches = store.events.filter((event) => event.title.startsWith("Council Open House"));
    assert.equal(matches.length, 2);
    assert.ok(matches.every((event) => event.status === "draft"));
  });

  it("adopts a changed identifier when the title and start instant are identical", async () => {
    const store = new MemoryStore();
    await run(store, makeFetch(await defaultRoutes()));
    const event = store.events.find((candidate) => candidate.title === "Winter Storytime");
    assert.ok(event);
    const originalId = event.id;
    const originalExternalId = event.externalId;

    // The source regenerated the .ics file, so the UID changed but the event
    // did not.
    const regenerated = (await fixture("event.ics")).replace(
      "UID:winter-storytime-2026-01-20@visittumblerridge.ca",
      "UID:storytime-regenerated-2026-01-20@visittumblerridge.ca",
    );
    const summary = await run(
      store,
      makeFetch(
        await defaultRoutes({
          ics: { "https://www.visittumblerridge.ca/events/winter-storytime.ics": regenerated },
        }),
      ),
    );

    assert.equal(summary.counts.imported, 0);
    assert.equal(store.events.length, 4);
    const updated = store.events.find((candidate) => candidate.id === originalId);
    assert.ok(updated);
    assert.notEqual(updated.externalId, originalExternalId);
    assert.equal(
      updated.externalId,
      "ics:uid:storytime-regenerated-2026-01-20@visittumblerridge.ca",
    );
  });

  it("never merges unrelated events that merely share a title", async () => {
    const store = new MemoryStore();
    await run(store, makeFetch(await defaultRoutes()));
    const original = store.events.find((event) => event.title === "Council Open House");
    assert.ok(original);

    // Same title, different day, different identifier.
    const page = (await fixture("listing.html")).replace(
      "dates=20260203T180000Z/20260203T200000Z",
      "dates=20260210T180000Z/20260210T200000Z",
    );
    const summary = await run(store, makeFetch(await defaultRoutes({ page })));

    assert.equal(summary.counts.imported, 1);
    assert.equal(store.events.length, 5);
    const matches = store.events.filter((event) => event.title === "Council Open House");
    assert.equal(matches.length, 2);
  });
});

describe("failures", () => {
  it("records a fetch failure and leaves every imported event untouched", async () => {
    const store = new MemoryStore();
    await run(store, makeFetch(await defaultRoutes()));
    const snapshot = store.events.map((event) => ({
      id: event.id,
      verified: event.lastVerifiedAt.toISOString(),
      title: event.title,
    }));
    const previousHealth = store.sources.get("visit-tumbler-ridge");
    assert.ok(previousHealth);

    const summary = await run(store, makeFetch({ throwOnPage: true }));

    assert.equal(summary.outcome, "failed");
    assert.equal(summary.errorCode, "fetch_network_error");
    assert.deepEqual(
      store.events.map((event) => ({
        id: event.id,
        verified: event.lastVerifiedAt.toISOString(),
        title: event.title,
      })),
      snapshot,
      "a failed fetch must not erase events or make them look fresh",
    );

    const health = store.sources.get("visit-tumbler-ridge");
    assert.ok(health);
    assert.equal(health.status, "failed");
    assert.equal(health.lastErrorCode, "fetch_network_error");
    assert.equal(health.consecutiveFailures, 1);
    assert.equal(health.lastFailureAt?.toISOString(), summary.finishedAt);
    assert.equal(
      health.lastSuccessAt?.toISOString(),
      previousHealth.lastSuccessAt?.toISOString(),
      "a failure does not become a success timestamp",
    );
  });

  it("records an HTTP error without touching data", async () => {
    const store = new MemoryStore();
    await run(store, makeFetch(await defaultRoutes()));
    const summary = await run(store, makeFetch({ pageStatus: 503, page: "unavailable" }));
    assert.equal(summary.outcome, "failed");
    assert.equal(summary.errorCode, "fetch_http_error");
    assert.equal(store.events.length, 4);
  });

  it("records a parsing failure without touching data", async () => {
    const store = new MemoryStore();
    await run(store, makeFetch(await defaultRoutes()));
    const summary = await run(
      store,
      makeFetch(await defaultRoutes({ page: await fixture("malformed.html") })),
    );

    assert.equal(summary.outcome, "failed");
    assert.equal(summary.errorCode, "parse_page_not_recognised");
    assert.equal(store.events.length, 4);
    assert.equal(store.sources.get("visit-tumbler-ridge")?.status, "failed");
  });

  it("holds a listing whose required fields cannot be read", async () => {
    const store = new MemoryStore();
    const page = `<html><body>
      <a href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;text=No+Date+Event">Add</a>
      <a href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;dates=20260301T180000Z/20260301T190000Z">No title</a>
    </body></html>`;

    const summary = await run(store, makeFetch({ page }));

    assert.equal(summary.counts.held, 2);
    assert.equal(summary.counts.imported, 0);
    assert.equal(store.events.length, 0);
    assert.deepEqual(summary.heldReasons, { missing_start: 1, missing_title: 1 });
    for (const item of store.items.values()) {
      assert.equal(item.outcome, "held");
      assert.ok(item.payload);
    }
  });

  it("holds one item when its ICS file fails, and still imports the others", async () => {
    const store = new MemoryStore();
    const summary = await run(
      store,
      makeFetch({
        ics: {
          "https://www.visittumblerridge.ca/events/all.ics": await fixture("feed.ics"),
        },
      }),
    );

    assert.equal(summary.outcome, "partial");
    assert.equal(summary.counts.imported, 3);
    // Two held: the missing .ics file, and the multi-event export.
    assert.equal(summary.counts.held, 2);
    assert.equal(store.events.some((event) => event.title === "Winter Storytime"), false);
    assert.equal(summary.heldReasons.ics_http_error, 1);
    assert.equal(summary.heldReasons.ics_multiple_events, 1);
  });

  it("reports an empty page as partial, not as a deletion", async () => {
    const store = new MemoryStore();
    await run(store, makeFetch(await defaultRoutes()));
    const page = `<html><body><a href="/">Home</a><a href="/about">About</a></body></html>`;
    const summary = await run(store, makeFetch({ page }));

    assert.equal(summary.outcome, "partial");
    assert.equal(summary.errorCode, "no_items_found");
    assert.equal(store.events.length, 4);
  });
});
