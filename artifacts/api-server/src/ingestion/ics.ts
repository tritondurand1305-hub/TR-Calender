import { parseIcsDate, type DateParseResult, type ParsedDate } from "./dateParsing.ts";

/**
 * A deliberately small iCalendar reader: enough to read the single-event feeds
 * a listing page links to (`VEVENT` with `DTSTART`, `SUMMARY`, `LOCATION`,
 * `DESCRIPTION`, `URL`, `UID`).
 *
 * Out of scope on purpose: recurrence expansion, `VTIMEZONE` definitions,
 * attendee data, alarms. A recurring event is reported as unsupported rather
 * than expanded into occurrences the source did not list, because inventing
 * future dates is exactly the failure this pipeline must avoid.
 */

export interface IcsEvent {
  uid: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  status: string | null;
  start: ParsedDate | null;
  end: ParsedDate | null;
  isRecurring: boolean;
  /** Why the event cannot be used, when it cannot. */
  problem:
    | "missing_start"
    | "invalid_start"
    | "unsupported_timezone"
    | "recurring_event_unsupported"
    | "cancelled"
    | null;
}

export interface IcsParseResult {
  events: IcsEvent[];
  /** Parser-level problems; never a reason to fail a whole page. */
  warnings: string[];
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** RFC 5545 line unfolding: a line starting with a space or tab continues the previous one. */
export function unfoldIcs(text: string): string[] {
  const unfolded = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
  return unfolded.split("\n");
}

function splitProperty(line: string): Property | null {
  let insideQuotes = false;
  let colon = -1;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') insideQuotes = !insideQuotes;
    else if (character === ":" && !insideQuotes) {
      colon = index;
      break;
    }
  }
  if (colon <= 0) return null;

  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [rawName, ...rawParams] = left.split(";");
  const name = (rawName ?? "").trim().toUpperCase();
  if (!name) return null;

  const params: Record<string, string> = {};
  for (const rawParam of rawParams) {
    const equals = rawParam.indexOf("=");
    if (equals <= 0) continue;
    const key = rawParam.slice(0, equals).trim().toUpperCase();
    let paramValue = rawParam.slice(equals + 1).trim();
    if (paramValue.startsWith('"') && paramValue.endsWith('"')) {
      paramValue = paramValue.slice(1, -1);
    }
    params[key] = paramValue;
  }
  return { name, params, value };
}

/** RFC 5545 TEXT unescaping for the fields we surface. */
export function unescapeIcsText(value: string): string {
  return value
    .replace(/\\[nN]/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function cleaned(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = unescapeIcsText(value).trim();
  return text.length > 0 ? text : null;
}

export function parseIcsCalendar(text: string): IcsParseResult {
  const warnings: string[] = [];
  const events: IcsEvent[] = [];

  let current: Map<string, Property> | null = null;
  let inEvent = false;

  for (const line of unfoldIcs(text)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^BEGIN:VEVENT$/i.test(trimmed)) {
      inEvent = true;
      current = new Map();
      continue;
    }
    if (/^END:VEVENT$/i.test(trimmed)) {
      if (current) events.push(buildEvent(current, warnings));
      inEvent = false;
      current = null;
      continue;
    }
    if (!inEvent || !current) continue;

    const property = splitProperty(line);
    if (!property) continue;
    // Keep the first occurrence of each property; iCalendar does not allow
    // duplicates for the ones we read.
    if (!current.has(property.name)) current.set(property.name, property);
  }

  if (inEvent) warnings.push("unterminated_vevent");
  return { events, warnings };
}

function buildEvent(
  properties: Map<string, Property>,
  warnings: string[],
): IcsEvent {
  const uid = cleaned(properties.get("UID")?.value) ?? null;
  const summary = cleaned(properties.get("SUMMARY")?.value) ?? null;
  const description = cleaned(properties.get("DESCRIPTION")?.value) ?? null;
  const location = cleaned(properties.get("LOCATION")?.value) ?? null;
  const url = cleaned(properties.get("URL")?.value) ?? null;
  const status = cleaned(properties.get("STATUS")?.value)?.toUpperCase() ?? null;
  const isRecurring = properties.has("RRULE") || properties.has("RDATE");
  if (isRecurring) warnings.push("recurring_event_unsupported");

  const startProperty = properties.get("DTSTART");
  const endProperty = properties.get("DTEND");

  const startResult = startProperty ? parseIcsPropertyDate(startProperty) : null;
  const endResult = endProperty ? parseIcsPropertyDate(endProperty) : null;
  const start = startResult?.ok ? startResult.value : null;
  const end = endResult?.ok ? endResult.value : null;

  let problem: IcsEvent["problem"] = null;
  if (status === "CANCELLED") problem = "cancelled";
  else if (isRecurring) problem = "recurring_event_unsupported";
  else if (!startProperty) problem = "missing_start";
  else if (startResult && !startResult.ok) {
    problem =
      startResult.reason === "unsupported_timezone" ? "unsupported_timezone" : "invalid_start";
  }

  return {
    uid,
    summary,
    description,
    location,
    url,
    status,
    start,
    end,
    isRecurring,
    problem,
  };
}

function parseIcsPropertyDate(property: Property): DateParseResult {
  // No TZID means a floating value: parseIcsDate assumes the community zone
  // and reports `assumedZone`, which the payload keeps for review.
  return parseIcsDate(property.value, {
    timeZone: property.params.TZID ?? null,
    valueType: property.params.VALUE ?? null,
  });
}
