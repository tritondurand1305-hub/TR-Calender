/**
 * Cross-field date checks for event payloads.
 *
 * Both the anonymous submission route and the administrator approval route use
 * this guard. The approval route is the only path that can publish an event, so
 * the check must exist server-side even though the browser form also validates
 * it: a hand-crafted request must not be able to publish an event that ends
 * before it starts.
 *
 * `endAt === startAt` is allowed (a zero-length event) because the published
 * contract only requires `endAt >= startAt`.
 */

/** Fixed, user-safe message. Shared so the two routes cannot drift apart. */
export const EVENT_INTERVAL_ERROR = "The event end must be after its start";

export function endsBeforeStart(startAt: Date, endAt: Date | null): boolean {
  if (endAt === null) return false;
  return endAt.getTime() < startAt.getTime();
}
