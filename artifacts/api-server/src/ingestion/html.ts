/**
 * Minimal HTML helpers.
 *
 * Deliberately selector-free. The live Visit Tumbler Ridge markup is not
 * available in this environment, so the adapter relies only on structures the
 * public web already defines: anchors (`href`), `<script type="application/
 * ld+json">` blocks, and the Google Calendar / iCalendar link formats. Nothing
 * here guesses at class names, ids or a component tree.
 *
 * This is not a general-purpose HTML parser. If the live page turns out to need
 * one, that is a deliberate, reviewable change (see docs/ingestion-visit-
 * tumbler-ridge.md), not something to smuggle in through a regex.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  hellip: "\u2026",
  eacute: "\u00e9",
  egrave: "\u00e8",
  agrave: "\u00e0",
  ccedil: "\u00e7",
  middot: "\u00b7",
  deg: "\u00b0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
};

/** Decode the entities that appear in ordinary page text. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Collapse runs of whitespace, including non-breaking spaces, to one space. */
export function collapseWhitespace(value: string): string {
  return value.replace(/[\s\u00a0]+/g, " ").trim();
}

/**
 * Convert an HTML fragment to readable text: drop scripts and styles, keep
 * paragraph and line breaks as spaces, strip the remaining tags, decode
 * entities and collapse whitespace.
 */
export function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const spaced = withoutScripts
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, " ");
  return collapseWhitespace(decodeHtmlEntities(spaced.replace(/<[^>]+>/g, " ")));
}

export interface Anchor {
  href: string;
  /** Link text, tag-stripped. Often "Add to calendar", not the event title. */
  text: string;
  /** Raw opening tag, for diagnostics only. */
  raw: string;
}

/** Every anchor with an href, in document order. */
export function extractAnchors(html: string): Anchor[] {
  const anchors: Anchor[] = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attributes = match[1] ?? "";
    const href = readAttribute(attributes, "href");
    if (!href) continue;
    anchors.push({
      href: decodeHtmlEntities(href).trim(),
      text: htmlToText(match[2] ?? ""),
      raw: match[0].slice(0, 300),
    });
  }
  return anchors;
}

/** Read one attribute from a raw attribute string. */
export function readAttribute(attributes: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = pattern.exec(attributes);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? null;
}

/** Parsed JSON from every `application/ld+json` block on the page. */
export function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const raw = (match[1] ?? "").trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // A malformed structured-data block is not a reason to fail the page:
      // the link-based candidates are still usable.
    }
  }
  return blocks;
}

/** `<link rel="alternate" type="text/calendar">` and friends. */
export function extractFeedHints(html: string): Array<{ href: string; title: string | null }> {
  const hints: Array<{ href: string; title: string | null }> = [];
  const pattern = /<link\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attributes = match[1] ?? "";
    const type = readAttribute(attributes, "type")?.toLowerCase() ?? "";
    const rel = readAttribute(attributes, "rel")?.toLowerCase() ?? "";
    const href = readAttribute(attributes, "href");
    if (!href) continue;
    if (type.includes("text/calendar") || (rel.includes("alternate") && /\.ics(\?|$)/i.test(href))) {
      hints.push({ href: decodeHtmlEntities(href).trim(), title: readAttribute(attributes, "title") });
    }
  }
  return hints;
}

/** Resolve a possibly relative href against the page URL. */
export function absoluteUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

const TRACKING_PARAMS = new Set([
  "pli",
  "uid",
  "sf",
  "output",
  "gflow",
  "usp",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
]);

/**
 * Stable form of a URL, used as a deduplication key when the source exposes no
 * identifier of its own: lower-case host, no fragment, sorted query with
 * tracking parameters removed, no trailing slash on the path.
 */
export function canonicalizeUrl(href: string): string {
  const url = new URL(href);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}
