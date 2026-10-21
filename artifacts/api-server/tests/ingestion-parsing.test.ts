/**
 * Unit tests for the Visit Tumbler Ridge adapter: page extraction, link
 * formats, secondary `.ics` resolution and within-page deduplication.
 *
 * Everything here runs on synthetic fixtures in `tests/fixtures/visit-tumbler-
 * ridge/`. No network request is made and no live page was ever fetched: this
 * environment has no outbound internet access. The fixtures are labelled
 * synthetic in their own README.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { dedupeListings } from "../src/ingestion/dedupe.ts";
import type { FetchLike } from "../src/ingestion/http.ts";
import { SourceParseError, type SourcePage } from "../src/ingestion/types.ts";
import {
  extractCandidates,
  inspectPage,
  perEventIcsUrl,
  resolveCandidates,
  VISIT_TUMBLER_RIDGE_EVENTS_URL,
} from "../src/ingestion/visitTumblerRidge.ts";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "visit-tumbler-ridge",
);

const PAGE_URL = VISIT_TUMBLER_RIDGE_EVENTS_URL;

async function fixture(name: string): Promise<string> {
  return readFile(path.join(fixtureDir, name), "utf8");
}

async function page(name = "listing.html"): Promise<SourcePage> {
  return {
    url: PAGE_URL,
    body: await fixture(name),
    fetchedAt: new Date("2026-01-02T12:00:00.000Z"),
  };
}

function context(routes: Record<string, { body: string; contentType?: string; status?: number }>) {
  const requested: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    requested.push(url);
    const route = routes[url];
    if (!route) throw new Error(`Unexpected fetch: ${url}`);
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { "content-type": route.contentType ?? "text/calendar" },
    });
  };
  return {
    requested,
    context: { fetch: fetchImpl, policy: {}, now: () => new Date("2026-01-02T12:00:00.000Z") },
  };
}

describe("listing page extraction", () => {
  it("reads structured data, Google Calendar links and per-event ICS links", async () => {
    const candidates = await extractCandidates(await page());

    const structured = candidates.filter((candidate) => candidate.kind === "structured-data");
    const google = candidates.filter((candidate) => candidate.kind === "google-calendar");
    const ics = candidates.filter((candidate) => candidate.kind === "ics");

    assert.equal(structured.length, 2);
    assert.equal(google.length, 2);
    assert.equal(ics.length, 2);
  });

  it("maps structured data into source fields without inventing anything", async () => {
    const candidates = await extractCandidates(await page());
    const tea = candidates.find((candidate) => candidate.title === "Seniors' Tea & Social");

    assert.ok(tea, "the structured tea event should be present");
    assert.equal(tea.kind, "structured-data");
    assert.equal(tea.location, "Tumbler Ridge Community Centre");
    assert.equal(tea.startAt?.toISOString(), "2026-01-16T03:00:00.000Z");
    assert.equal(tea.endAt?.toISOString(), "2026-01-16T05:00:00.000Z");
    assert.equal(tea.allDay, false);
    assert.equal(tea.sourceUrl, "https://www.visittumblerridge.ca/events/seniors-tea");
    assert.match(tea.externalId, /^structured:https:\/\/www\.visittumblerridge\.ca\/events\/seniors-tea$/);
  });

  it("treats a date-only structured value as an all-day event in the community zone", async () => {
    const candidates = await extractCandidates(await page());
    const closed = candidates.find((candidate) => candidate.title === "Library Closed — Staff Training");

    assert.ok(closed);
    assert.equal(closed.allDay, true);
    // 2026-01-22 00:00 in America/Vancouver (PST, UTC-8).
    assert.equal(closed.startAt?.toISOString(), "2026-01-22T08:00:00.000Z");
    assert.equal(closed.endAt, null);
  });

  it("decodes a Google Calendar template link, including ctz wall-clock times", async () => {
    const candidates = await extractCandidates(await page());
    const tea = candidates.find((candidate) => candidate.kind === "google-calendar" && candidate.title === "Seniors' Tea & Social");

    assert.ok(tea);
    assert.equal(tea.startAt?.toISOString(), "2026-01-16T03:00:00.000Z");
    assert.equal(tea.endAt?.toISOString(), "2026-01-16T05:00:00.000Z");
    assert.equal(tea.location, "Tumbler Ridge Community Centre");
    assert.match(tea.description ?? "", /Tea, coffee & conversation/);
    assert.equal(tea.sourceUrl, PAGE_URL);
  });

  it("reads UTC Google Calendar dates exactly as written", async () => {
    const candidates = await extractCandidates(await page());
    const council = candidates.find((candidate) => candidate.title === "Council Open House");

    assert.ok(council);
    assert.equal(council.startAt?.toISOString(), "2026-02-03T18:00:00.000Z");
    assert.equal(council.endAt?.toISOString(), "2026-02-03T20:00:00.000Z");
  });

  it("leaves a missing date null rather than inventing one", async () => {
    const html = `<html><body>
      <a href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;text=Undated+Event">Add</a>
    </body></html>`;
    const candidates = extractCandidates({ url: PAGE_URL, body: html, fetchedAt: new Date() });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.startAt, null);
    assert.equal(candidates[0]?.title, "Undated Event");
  });

  it("ignores ordinary navigation links", async () => {
    const html = `<html><body>
      <a href="/">Home</a><a href="/events/seniors-tea">Seniors' Tea</a>
      <a href="mailto:events@example.ca">Email</a>
    </body></html>`;
    assert.deepEqual(extractCandidates({ url: PAGE_URL, body: html, fetchedAt: new Date() }), []);
  });

  it("fails loudly when the page is not a listing page at all", async () => {
    assert.throws(
      () => extractCandidates({ url: PAGE_URL, body: "<html><body></body></html>", fetchedAt: new Date() }),
      (error: unknown) =>
        error instanceof SourceParseError && error.code === "page_not_recognised",
    );
  });

  it("reports structure counts for a live verification run", async () => {
    const inspection = inspectPage(await page());
    assert.equal(inspection.structuredEvents, 2);
    assert.equal(inspection.googleCalendarLinks, 2);
    assert.equal(inspection.icsLinks, 2);
    assert.deepEqual(inspection.feedHints, ["https://www.visittumblerridge.ca/events/all.ics"]);
  });
});

describe("per-event ICS link rules", () => {
  it("accepts an .ics file on the source host", () => {
    assert.equal(
      perEventIcsUrl("https://www.visittumblerridge.ca/events/winter-storytime.ics", PAGE_URL),
      "https://www.visittumblerridge.ca/events/winter-storytime.ics",
    );
  });

  it("converts a webcal link to https", () => {
    assert.equal(
      perEventIcsUrl("webcal://www.visittumblerridge.ca/events/storytime.ics", PAGE_URL),
      "https://www.visittumblerridge.ca/events/storytime.ics",
    );
  });

  it("accepts a Google-hosted file only when it carries an event id", () => {
    const perEvent =
      "https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/public/basic.ics?eid=xyz";
    assert.equal(perEventIcsUrl(perEvent, PAGE_URL), perEvent);
    assert.equal(
      perEventIcsUrl(
        "https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/public/basic.ics",
        PAGE_URL,
      ),
      null,
    );
  });

  it("rejects another host's calendar file and non-ICS links", () => {
    assert.equal(perEventIcsUrl("https://feeds.example.ca/events.ics", PAGE_URL), null);
    assert.equal(perEventIcsUrl("https://www.visittumblerridge.ca/events", PAGE_URL), null);
  });
});

describe("secondary ICS resolution", () => {
  it("resolves a per-event file into a listing and holds a multi-event feed", async () => {
    const candidates = await extractCandidates(await page());
    const { context: fetchContext, requested } = context({
      "https://www.visittumblerridge.ca/events/winter-storytime.ics": {
        body: await fixture("event.ics"),
      },
      "https://www.visittumblerridge.ca/events/all.ics": { body: await fixture("feed.ics") },
    });

    const resolved = await resolveCandidates(candidates, fetchContext);
    assert.deepEqual(requested.sort(), [
      "https://www.visittumblerridge.ca/events/all.ics",
      "https://www.visittumblerridge.ca/events/winter-storytime.ics",
    ]);

    const storytime = resolved.find((listing) => listing.title === "Winter Storytime");
    assert.ok(storytime, "the per-event ICS should resolve to a listing");
    assert.equal(storytime.problem, null);
    assert.equal(storytime.externalId, "ics:uid:winter-storytime-2026-01-20@visittumblerridge.ca");
    assert.equal(storytime.location, "Tumbler Ridge Public Library, 100 Founders Way");
    assert.match(storytime.description ?? "", /Drop in, no registration needed\./);
    assert.equal(storytime.startAt?.toISOString(), "2026-01-20T18:30:00.000Z");
    assert.equal(storytime.endAt?.toISOString(), "2026-01-20T19:30:00.000Z");

    const feed = resolved.find((listing) => listing.externalId.includes("/events/all.ics"));
    assert.ok(feed, "the shared export should still be recorded");
    assert.equal(feed.problem, "ics_multiple_events");
  });

  it("holds the item when its ICS file cannot be fetched, without failing the page", async () => {
    const candidates = await extractCandidates(await page());
    const { context: fetchContext } = context({
      "https://www.visittumblerridge.ca/events/winter-storytime.ics": {
        body: "upstream unavailable",
        status: 503,
      },
      "https://www.visittumblerridge.ca/events/all.ics": { body: await fixture("feed.ics") },
    });

    const resolved = await resolveCandidates(candidates, fetchContext);
    const storytime = resolved.find((listing) => listing.kind === "ics" && listing.problem);
    assert.ok(storytime);
    assert.equal(storytime.problem, "ics_http_error");
    // The other listings are untouched by one failed file.
    assert.ok(resolved.some((listing) => listing.title === "Council Open House" && !listing.problem));
  });

  it("holds a recurring event rather than expanding it into occurrences", async () => {
    const candidates = [
      {
        kind: "ics" as const,
        externalId: "ics:https://www.visittumblerridge.ca/events/drop-in-hockey.ics",
        sourceUrl: PAGE_URL,
        dataUrl: "https://www.visittumblerridge.ca/events/drop-in-hockey.ics",
        title: null,
        description: null,
        location: null,
        startAt: null,
        endAt: null,
        allDay: false,
        payload: {},
        problem: null,
      },
    ];
    const { context: fetchContext } = context({
      "https://www.visittumblerridge.ca/events/drop-in-hockey.ics": {
        body: await fixture("recurring.ics"),
      },
    });
    const resolved = await resolveCandidates(candidates, fetchContext);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.problem, "recurring_event_unsupported");
  });
});

describe("identifier fallbacks", () => {
  it("uses the canonical .ics URL when the file has no UID", async () => {
    const candidates = [
      {
        kind: "ics" as const,
        externalId: "ics:https://www.visittumblerridge.ca/events/no-uid.ics",
        sourceUrl: PAGE_URL,
        dataUrl: "https://www.visittumblerridge.ca/events/no-uid.ics",
        title: null,
        description: null,
        location: null,
        startAt: null,
        endAt: null,
        allDay: false,
        payload: {},
        problem: null,
      },
    ];
    const { context: fetchContext } = context({
      "https://www.visittumblerridge.ca/events/no-uid.ics": {
        body: [
          "BEGIN:VCALENDAR",
          "BEGIN:VEVENT",
          "SUMMARY:No UID Event",
          "DTSTART:20260205T180000Z",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
      },
    });

    const resolved = await resolveCandidates(candidates, fetchContext);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.externalId, "ics:https://www.visittumblerridge.ca/events/no-uid.ics");
    assert.equal(resolved[0]?.title, "No UID Event");
  });

  it("uses the listing page and start instant when structured data has no url or @id", async () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"Event","name":"Unlinked Event","startDate":"2026-03-04T19:00:00-08:00"}
    </script></head><body><a href="/">Home</a></body></html>`;
    const candidates = extractCandidates({ url: PAGE_URL, body: html, fetchedAt: new Date() });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.externalId, `structured:${PAGE_URL}#2026-03-05T03:00:00.000Z`);
    assert.equal(candidates[0]?.sourceUrl, PAGE_URL);
  });
});

describe("within-page deduplication", () => {
  it("keeps one listing when the same event appears as structured data and a calendar link", async () => {
    const candidates = await extractCandidates(await page());
    const { context: fetchContext } = context({
      "https://www.visittumblerridge.ca/events/winter-storytime.ics": {
        body: await fixture("event.ics"),
      },
      "https://www.visittumblerridge.ca/events/all.ics": { body: await fixture("feed.ics") },
    });
    const resolved = await resolveCandidates(candidates, fetchContext);
    const deduped = dedupeListings(resolved);

    const tea = deduped.filter((listing) => listing.title === "Seniors' Tea & Social");
    assert.equal(tea.length, 1);
    // Structured data wins over the Google Calendar duplicate.
    assert.equal(tea[0]?.kind, "structured-data");

    assert.equal(deduped.length, 5, "two structured, one Google-only, one ICS, one held feed");
  });

  it("does not merge unrelated events that share a title but not a start time", () => {
    const base = {
      sourceUrl: PAGE_URL,
      description: null,
      location: null,
      allDay: false,
      kind: "structured-data" as const,
      payload: {},
      problem: null,
    };
    const listings = dedupeListings([
      { ...base, externalId: "a", title: "Coffee Morning", startAt: new Date("2026-02-01T17:00:00Z"), endAt: null },
      { ...base, externalId: "b", title: "Coffee Morning", startAt: new Date("2026-02-08T17:00:00Z"), endAt: null },
    ]);
    assert.equal(listings.length, 2);
  });
});
