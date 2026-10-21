/**
 * Time handling for imported listings.
 *
 * Tumbler Ridge events are published in the community's own timezone. All
 * stored timestamps are `timestamptz`, so every wall-clock value read from a
 * source must be converted through that zone rather than through the server's
 * local timezone.
 *
 * No timezone database is bundled: `Intl` is the only source of offsets. A
 * wall time that falls in a daylight-saving gap resolves to the offset in
 * effect at the earlier instant, which is the same behaviour a reader using
 * the source page would see.
 */

export const COMMUNITY_TIME_ZONE = "America/Vancouver";

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Offset in milliseconds of `timeZone` at `instant` (local minus UTC). */
function offsetAt(instant: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Convert a wall-clock time in `timeZone` to the matching UTC instant.
 *
 * Two passes handle the offset changing between the first guess and the real
 * instant (the DST transition). An invalid zone name throws a RangeError from
 * Intl; callers treat that as an unsupported source value.
 */
export function wallClockToUtc(wall: WallClock, timeZone: string): Date {
  const guess = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  const firstOffset = offsetAt(new Date(guess), timeZone);
  let candidate = guess - firstOffset;
  const secondOffset = offsetAt(new Date(candidate), timeZone);
  if (secondOffset !== firstOffset) {
    candidate = guess - secondOffset;
  }
  return new Date(candidate);
}

/** Start of a calendar day in the community timezone. */
export function startOfCommunityDay(
  year: number,
  month: number,
  day: number,
): Date {
  return wallClockToUtc(
    { year, month, day, hour: 0, minute: 0, second: 0 },
    COMMUNITY_TIME_ZONE,
  );
}
