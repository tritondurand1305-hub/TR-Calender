/**
 * Unit tests for the iCalendar reader and the date handling it depends on.
 *
 * The fixtures are synthetic (see tests/fixtures/visit-tumbler-ridge/README.md).
 * No network and no database are involved.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseGoogleCalendarDates, parseIcsDate } from "../src/ingestion/dateParsing.ts";
import { parseIcsCalendar, unfoldIcs } from "../src/ingestion/ics.ts";
import { wallClockToUtc } from "../src/ingestion/time.ts";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "visit-tumbler-ridge",
);

async function fixture(name: string): Promise<string> {
  return readFile(path.join(fixtureDir, name), "utf8");
}

describe("iCalendar parsing", () => {
  it("reads a single-event file with a UID, TZID times and escaped text", async () => {
    const { events, warnings } = parseIcsCalendar(await fixture("event.ics"));

    assert.equal(warnings.length, 0);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.ok(event);
    assert.equal(event.uid, "winter-storytime-2026-01-20@visittumblerridge.ca");
    assert.equal(event.summary, "Winter Storytime");
    assert.equal(event.location, "Tumbler Ridge Public Library, 100 Founders Way");
    assert.equal(event.status, "CONFIRMED");
    assert.equal(event.problem, null);
    assert.equal(event.start?.date.toISOString(), "2026-01-20T18:30:00.000Z");
    assert.equal(event.end?.date.toISOString(), "2026-01-20T19:30:00.000Z");
    assert.equal(event.start?.allDay, false);
  });

  it("unfolds a continuation line before reading the value", async () => {
    const { events } = parseIcsCalendar(await fixture("event.ics"));
    // The description is folded mid-word in the fixture and contains "\n" and
    // an escaped comma.
    assert.match(events[0]?.description ?? "", /Drop in, no registration needed\./);
    assert.match(events[0]?.description ?? "", /ages 0-5\.\n/);
  });

  it("reads an all-day VALUE=DATE event as midnight in the community zone", async () => {
    const { events } = parseIcsCalendar(await fixture("all-day.ics"));
    const event = events[0];
    assert.ok(event);
    assert.equal(event.problem, null);
    assert.equal(event.start?.allDay, true);
    assert.equal(event.start?.date.toISOString(), "2026-01-22T08:00:00.000Z");
    // DTEND in an all-day event is exclusive; the mapper drops it rather than
    // display an end date one day late.
    assert.equal(event.end?.date.toISOString(), "2026-01-23T08:00:00.000Z");
  });

  it("refuses to expand a recurring event", async () => {
    const { events, warnings } = parseIcsCalendar(await fixture("recurring.ics"));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.isRecurring, true);
    assert.equal(events[0]?.problem, "recurring_event_unsupported");
    assert.ok(warnings.includes("recurring_event_unsupported"));
  });

  it("reports a missing DTSTART instead of inventing one", () => {
    const { events } = parseIcsCalendar(
      "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nSUMMARY:No date\nEND:VEVENT\nEND:VCALENDAR",
    );
    assert.equal(events[0]?.problem, "missing_start");
    assert.equal(events[0]?.start, null);
  });

  it("reports an unknown timezone instead of guessing an offset", () => {
    const { events } = parseIcsCalendar(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:x",
        "SUMMARY:Mars time",
        "DTSTART;TZID=Not/AZone:20260115T190000",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\n"),
    );
    assert.equal(events[0]?.problem, "unsupported_timezone");
    assert.equal(events[0]?.start, null);
  });

  it("marks a cancelled event so it is never published", () => {
    const { events } = parseIcsCalendar(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:x",
        "SUMMARY:Cancelled thing",
        "STATUS:CANCELLED",
        "DTSTART:20260201T180000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\n"),
    );
    assert.equal(events[0]?.problem, "cancelled");
  });

  it("unfolds lines that start with a space or a tab", () => {
    assert.deepEqual(
      unfoldIcs("SUMMARY:Hello\r\n World\r\n\tagain\r\n"),
      ["SUMMARY:HelloWorldagain", ""],
    );
  });

  it("reads UTC values exactly as written", async () => {
    const { events } = parseIcsCalendar(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:x",
        "SUMMARY:UTC event",
        "DTSTART:20260301T150000Z",
        "DTEND:20260301T160000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\n"),
    );
    assert.equal(events[0]?.start?.date.toISOString(), "2026-03-01T15:00:00.000Z");
    assert.equal(events[0]?.start?.assumedZone, false);
  });

  it("assumes the community zone for a floating time and says so", async () => {
    const { events } = parseIcsCalendar(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:x",
        "SUMMARY:Floating",
        "DTSTART:20260115T190000",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\n"),
    );
    assert.equal(events[0]?.start?.date.toISOString(), "2026-01-16T03:00:00.000Z");
    assert.equal(events[0]?.start?.assumedZone, true);
  });
});

describe("date handling", () => {
  it("converts a summer wall time with the daylight-saving offset", () => {
    assert.equal(
      wallClockToUtc(
        { year: 2026, month: 7, day: 15, hour: 19, minute: 0, second: 0 },
        "America/Vancouver",
      ).toISOString(),
      "2026-07-16T02:00:00.000Z",
    );
  });

  it("converts a winter wall time with the standard offset", () => {
    assert.equal(
      wallClockToUtc(
        { year: 2026, month: 1, day: 15, hour: 19, minute: 0, second: 0 },
        "America/Vancouver",
      ).toISOString(),
      "2026-01-16T03:00:00.000Z",
    );
  });

  it("rejects a date that does not exist", () => {
    assert.deepEqual(parseIcsDate("20260231", {}), { ok: false, reason: "invalid_date" });
  });

  it("parses an all-day Google Calendar range", () => {
    const parsed = parseGoogleCalendarDates("20260115/20260116", null);
    assert.ok(parsed);
    assert.equal(parsed.start.allDay, true);
    assert.equal(parsed.start.date.toISOString(), "2026-01-15T08:00:00.000Z");
    assert.equal(parsed.end?.date.toISOString(), "2026-01-16T08:00:00.000Z");
  });

  it("returns null for a Google Calendar range it cannot read", () => {
    assert.equal(parseGoogleCalendarDates("not-a-date", null), null);
  });
});
