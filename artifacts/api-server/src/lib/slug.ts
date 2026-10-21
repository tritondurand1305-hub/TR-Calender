import { randomBytes } from "node:crypto";

/**
 * Public, shareable event slug.
 *
 * The random suffix keeps the unique index safe even when two events share a
 * title, and keeps slugs unguessable enough that a draft cannot be discovered
 * from a published one. Extracted from the events and submissions routes so
 * the ingestion pipeline writes the same shape.
 */
export function slugFor(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-CA")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${base || "event"}-${randomBytes(3).toString("hex")}`;
}
