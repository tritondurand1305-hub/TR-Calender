import { COMMUNITY_TIME_ZONE, startOfCommunityDay, wallClockToUtc } from "./time.ts";

/**
 * Date parsing for the two source formats the adapter understands:
 * iCalendar `DATE` / `DATE-TIME` values and ISO 8601 strings from schema.org
 * structured data. Nothing here guesses a missing date: an unreadable value
 * returns an error that the caller turns into a held item.
 */

export interface ParsedDate {
  date: Date;
  /** A date with no time component; the event is an all-day event. */
  allDay: boolean;
  /** The value carried no timezone, so the community zone was assumed. */
  assumedZone: boolean;
}

export type DateParseResult =
  | { ok: true; value: ParsedDate }
  | { ok: false; reason: "invalid_date" | "unsupported_timezone" };

function wallParts(value: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} | null {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) {
    return {
      year: Number(dateOnly[1]),
      month: Number(dateOnly[2]),
      day: Number(dateOnly[3]),
      hour: 0,
      minute: 0,
      second: 0,
    };
  }
  const withTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/.exec(value);
  if (withTime) {
    return {
      year: Number(withTime[1]),
      month: Number(withTime[2]),
      day: Number(withTime[3]),
      hour: Number(withTime[4]),
      minute: Number(withTime[5]),
      second: Number(withTime[6] ?? "0"),
    };
  }
  return null;
}

/**
 * Parse an iCalendar DATE or DATE-TIME value.
 *
 * `20260115`            → all-day, 15 January
 * `20260115T190000Z`    → 19:00 UTC
 * `20260115T190000`     → 19:00 in `timeZone` (TZID) or the community zone
 */
export function parseIcsDate(
  raw: string,
  options: { timeZone?: string | null; valueType?: string | null } = {},
): DateParseResult {
  const value = raw.trim();
  const isUtc = /Z$/.test(value);
  const withoutZone = isUtc ? value.slice(0, -1) : value;
  const parts = wallParts(withoutZone);
  if (!parts) return { ok: false, reason: "invalid_date" };

  const dateOnly = /^\d{8}$/.test(withoutZone) || options.valueType?.toUpperCase() === "DATE";
  if (dateOnly) {
    if (!validCalendarDate(parts)) return { ok: false, reason: "invalid_date" };
    return {
      ok: true,
      value: {
        date: startOfCommunityDay(parts.year, parts.month, parts.day),
        allDay: true,
        assumedZone: false,
      },
    };
  }

  if (!validCalendarDate(parts)) return { ok: false, reason: "invalid_date" };

  if (isUtc) {
    return {
      ok: true,
      value: {
        date: new Date(
          Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second),
        ),
        allDay: false,
        assumedZone: false,
      },
    };
  }

  const timeZone = options.timeZone?.trim() || COMMUNITY_TIME_ZONE;
  try {
    return {
      ok: true,
      value: {
        date: wallClockToUtc(parts, timeZone),
        allDay: false,
        assumedZone: !options.timeZone,
      },
    };
  } catch {
    // Intl rejects unknown zone names with a RangeError.
    return { ok: false, reason: "unsupported_timezone" };
  }
}

function validCalendarDate(parts: { year: number; month: number; day: number; hour: number; minute: number; second: number }): boolean {
  if (parts.month < 1 || parts.month > 12) return false;
  if (parts.day < 1 || parts.day > 31) return false;
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 60) return false;
  const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return probe.getUTCMonth() === parts.month - 1 && probe.getUTCDate() === parts.day;
}

/**
 * Parse an ISO 8601 date or date-time from structured data.
 *
 * A date-only value (`2026-01-15`) is an all-day event in the community zone;
 * a value with an offset or `Z` is used exactly as written.
 */
export function parseIsoDate(raw: string): DateParseResult {
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    if (!validCalendarDate({ year, month, day, hour: 0, minute: 0, second: 0 })) {
      return { ok: false, reason: "invalid_date" };
    }
    return {
      ok: true,
      value: { date: startOfCommunityDay(year, month, day), allDay: true, assumedZone: false },
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return { ok: false, reason: "invalid_date" };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { ok: false, reason: "invalid_date" };
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
  return { ok: true, value: { date, allDay: false, assumedZone: !hasZone } };
}

/**
 * Parse a Google Calendar `dates=` parameter.
 *
 * `20260115T190000Z/20260115T210000Z`        → explicit UTC instants
 * `20260115T190000/20260115T210000` + ctz   → wall time in `ctz`
 * `20260115/20260116`                        → all-day, end date exclusive
 */
export function parseGoogleCalendarDates(
  raw: string,
  timeZone: string | null,
): { start: ParsedDate; end: ParsedDate | null } | null {
  const [startRaw, endRaw] = raw.split("/");
  if (!startRaw) return null;
  const start = parseIcsDate(startRaw, { timeZone });
  if (!start.ok) return null;
  let end: ParsedDate | null = null;
  if (endRaw) {
    const parsedEnd = parseIcsDate(endRaw, { timeZone });
    if (parsedEnd.ok) end = parsedEnd.value;
  }
  return { start: start.value, end };
}
