/**
 * Unit tests for the retrieval boundary.
 *
 * A fake `fetch` is injected for every case, so no request leaves the process.
 * The timeout case uses the real AbortSignal machinery, not a stub, so it also
 * proves that an unresponsive source cannot hang a run.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fetchDocument, SourceFetchError, type FetchLike } from "../src/ingestion/http.ts";

const URL_UNDER_TEST = "https://example.test/events";

function responder(
  body: string,
  init: { status?: number; contentType?: string | null; url?: string } = {},
): FetchLike {
  return async () =>
    new Response(body, {
      status: init.status ?? 200,
      headers: init.contentType === null ? {} : { "content-type": init.contentType ?? "text/html" },
    });
}

describe("fetchDocument", () => {
  it("returns the body, content type and validators for a successful response", async () => {
    const document = await fetchDocument(URL_UNDER_TEST, {
      fetch: responder("<html>ok</html>"),
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    assert.equal(document.body, "<html>ok</html>");
    assert.equal(document.contentType, "text/html");
    assert.equal(document.fetchedAt.toISOString(), "2026-01-02T00:00:00.000Z");
    assert.equal(document.url, URL_UNDER_TEST);
  });

  it("sends a descriptive user agent and an Accept header", async () => {
    // A container, because TypeScript's flow analysis cannot see the
    // assignment that happens inside the callback below.
    const captured: { headers: Headers | null } = { headers: null };
    const fetchImpl: FetchLike = async (_url, init) => {
      captured.headers = new Headers(init?.headers);
      return new Response("<html></html>", { headers: { "content-type": "text/html" } });
    };
    await fetchDocument(URL_UNDER_TEST, { fetch: fetchImpl, policy: { userAgent: "TRBot/1.0" } });
    assert.ok(captured.headers);
    const headers = captured.headers;
    assert.equal(headers.get("user-agent"), "TRBot/1.0");
    assert.match(headers.get("accept") ?? "", /text\/html/);
  });

  it("treats a non-2xx response as a failure, never as an empty listing", async () => {
    await assert.rejects(
      () => fetchDocument(URL_UNDER_TEST, { fetch: responder("gone", { status: 404 }) }),
      (error: unknown) =>
        error instanceof SourceFetchError &&
        error.code === "http_error" &&
        error.status === 404,
    );
  });

  it("rejects a clearly wrong content type", async () => {
    await assert.rejects(
      () =>
        fetchDocument(URL_UNDER_TEST, {
          fetch: responder('{"events":[]}', { contentType: "application/json" }),
        }),
      (error: unknown) =>
        error instanceof SourceFetchError && error.code === "unexpected_content_type",
    );
  });

  it("accepts a missing content type and lets the parser decide", async () => {
    // A hand-built response, because `new Response(...)` always adds a
    // content type of its own.
    const fetchImpl: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        url: URL_UNDER_TEST,
        headers: new Headers(),
        arrayBuffer: async () => new TextEncoder().encode("<html>ok</html>").buffer,
      }) as unknown as Response;
    const document = await fetchDocument(URL_UNDER_TEST, { fetch: fetchImpl });
    assert.equal(document.body, "<html>ok</html>");
  });

  it("refuses a body above the size limit", async () => {
    await assert.rejects(
      () =>
        fetchDocument(URL_UNDER_TEST, {
          fetch: responder("x".repeat(500)),
          policy: { maxBytes: 100 },
        }),
      (error: unknown) => error instanceof SourceFetchError && error.code === "too_large",
    );
  });

  it("refuses an empty body", async () => {
    await assert.rejects(
      () => fetchDocument(URL_UNDER_TEST, { fetch: responder("") }),
      (error: unknown) => error instanceof SourceFetchError && error.code === "empty_body",
    );
  });

  it("classifies a thrown network error", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    await assert.rejects(
      () => fetchDocument(URL_UNDER_TEST, { fetch: fetchImpl }),
      (error: unknown) => error instanceof SourceFetchError && error.code === "network_error",
    );
  });

  it("aborts an unresponsive source instead of hanging the run", async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    await assert.rejects(
      () => fetchDocument(URL_UNDER_TEST, { fetch: fetchImpl, policy: { timeoutMs: 25 } }),
      (error: unknown) => error instanceof SourceFetchError && error.code === "timeout",
    );
  });

  it("accepts a calendar body for the calendar kind", async () => {
    const document = await fetchDocument(URL_UNDER_TEST, {
      fetch: responder("BEGIN:VCALENDAR", { contentType: "text/calendar" }),
      kind: "calendar",
    });
    assert.equal(document.body, "BEGIN:VCALENDAR");
  });
});
