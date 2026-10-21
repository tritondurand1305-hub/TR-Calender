/**
 * HTTP retrieval for ingestion, isolated from parsing.
 *
 * The fetch implementation is injected so the parser and the pipeline can be
 * tested without a network, and so a deployment can swap in a client with its
 * own egress policy. Every failure is a typed `SourceFetchError`; nothing here
 * throws a bare network error that would be hard to classify in source health.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type FetchErrorCode =
  | "timeout"
  | "network_error"
  | "http_error"
  | "unexpected_content_type"
  | "too_large"
  | "empty_body";

export class SourceFetchError extends Error {
  readonly code: FetchErrorCode;
  readonly status: number | null;

  constructor(code: FetchErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "SourceFetchError";
    this.code = code;
    this.status = status;
  }
}

export interface FetchPolicy {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
}

export const DEFAULT_FETCH_POLICY: FetchPolicy = {
  userAgent:
    "TRCalendarBot/1.0 (+https://www.tumblridgecalendar.ca; community calendar import)",
  timeoutMs: 15_000,
  maxBytes: 2_000_000,
};

export interface FetchedDocument {
  /** Final URL after redirects. */
  url: string;
  body: string;
  contentType: string | null;
  fetchedAt: Date;
  etag: string | null;
  lastModified: string | null;
}

const HTML_TYPES = ["text/html", "application/xhtml+xml"];
const CALENDAR_TYPES = ["text/calendar", "text/plain", "application/octet-stream"];

function allowedContentType(contentType: string | null, kind: "html" | "calendar"): boolean {
  // A missing Content-Type is common on small sites; accept it and let parsing
  // decide. A clearly different type (JSON, an image) is a source problem.
  if (!contentType) return true;
  const lowered = contentType.toLowerCase();
  const allowed = kind === "html" ? HTML_TYPES : CALENDAR_TYPES;
  return allowed.some((type) => lowered.includes(type));
}

/**
 * Fetch a document as text with a timeout and a size limit.
 *
 * A non-2xx response is an error: ingestion never treats an error page as an
 * empty listing, because that would look like every event disappeared.
 */
export async function fetchDocument(
  url: string,
  options: {
    fetch: FetchLike;
    policy?: Partial<FetchPolicy>;
    kind?: "html" | "calendar";
    signal?: AbortSignal;
    now?: () => Date;
  },
): Promise<FetchedDocument> {
  const policy = { ...DEFAULT_FETCH_POLICY, ...options.policy };
  const kind = options.kind ?? "html";
  const now = options.now ?? (() => new Date());

  // A referenced timer, not AbortSignal.timeout(): the timeout must fire even
  // when the connection is stuck before the socket keeps the event loop busy.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, policy.timeoutMs);
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  const classify = (error: unknown): SourceFetchError => {
    if (timedOut) {
      return new SourceFetchError("timeout", `Timed out after ${policy.timeoutMs} ms`);
    }
    if (options.signal?.aborted) {
      return new SourceFetchError("network_error", "Request cancelled");
    }
    return new SourceFetchError(
      "network_error",
      error instanceof Error ? error.message : "Network request failed",
    );
  };

  try {
    let response: Response;
    try {
      response = await options.fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          accept:
            kind === "html" ? "text/html,application/xhtml+xml" : "text/calendar,text/plain",
          "user-agent": policy.userAgent,
        },
      });
    } catch (error) {
      throw classify(error);
    }

    if (!response.ok) {
      throw new SourceFetchError(
        "http_error",
        `Source responded ${response.status}`,
        response.status,
      );
    }

    const contentType = response.headers.get("content-type");
    if (!allowedContentType(contentType, kind)) {
      throw new SourceFetchError(
        "unexpected_content_type",
        `Source responded with ${contentType ?? "an unknown content type"}`,
        response.status,
      );
    }

    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (error) {
      throw classify(error);
    }

    if (buffer.byteLength > policy.maxBytes) {
      throw new SourceFetchError(
        "too_large",
        `Source body is ${buffer.byteLength} bytes, above the ${policy.maxBytes} byte limit`,
      );
    }
    if (buffer.byteLength === 0) {
      throw new SourceFetchError("empty_body", "Source returned an empty body");
    }

    return {
      url: response.url || url,
      body: new TextDecoder("utf-8").decode(buffer),
      contentType,
      fetchedAt: now(),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
