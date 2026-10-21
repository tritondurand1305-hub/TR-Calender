/**
 * Deterministic text cleanup for event normalisation.
 *
 * This module is intentionally dependency-free and pure: no clock, no
 * randomness, no locale-sensitive operations and no network access. Every
 * function returns the same result for the same input.
 *
 * Policy is taken from `docs/event-format-rules.md` (§Writing style): correct
 * obvious formatting, avoid all-caps and emoji in public copy, and never add
 * information that was not in the source.
 */

/** C0/C1 control characters, excluding tab and newline (handled separately). */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Invisible formatting characters that can hide or reorder text.
 * Zero-width joiners/non-joiners are intentionally kept: they are meaningful
 * inside several scripts, and emoji sequences are removed whole below.
 */
const FORMAT_CHARACTERS = /[\u200B\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * Emoji, keycaps, flags and variation selectors. Matched as whole sequences so
 * that no stray joiner or variation selector is left behind.
 */
const EMOJI_SEQUENCE = new RegExp(
  [
    "[0-9#*]\\uFE0F?\\u20E3",
    "\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?)*",
    "[\\u{1F1E6}-\\u{1F1FF}]{2}",
    "\\uFE0F",
    "\\u20E3",
  ].join("|"),
  "gu",
);

/** Common typographic characters normalised to their plain ASCII equivalents. */
const TYPOGRAPHIC_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2018\u2019\u201A\u2032]/g, "'"],
  [/[\u201C\u201D\u201E\u2033]/g, '"'],
  [/[\u2013\u2014]/g, "-"],
  [/\u2026/g, "..."],
];

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&nbsp;": " ",
  "&#39;": "'",
  "&quot;": '"',
  "&lt;": "<",
  "&gt;": ">",
};

const HTML_ENTITY_PATTERN = /&(?:amp|nbsp|#39|quot|lt|gt);/g;

/**
 * Acronyms preserved when converting an ALL CAPS title to title case.
 * A closed list keeps normal words ("FAIR", "FOOD", "SALE") out of the
 * acronym path, which a length heuristic alone gets wrong.
 */
const ACRONYMS: ReadonlySet<string> = new Set([
  "AGM", "ATV", "BC", "BCAA", "BBQ", "CPR", "GST", "HOA", "MLA", "MP", "PST",
  "RCMP", "SPCA", "SUV", "YMCA", "YWCA",
]);

/** Abbreviations that should not end a sentence when summarising. */
const SENTENCE_ABBREVIATIONS: ReadonlySet<string> = new Set([
  "approx", "ave", "blvd", "dr", "etc", "e.g", "i.e", "jr", "mr", "mrs", "ms",
  "mt", "no", "rd", "sr", "st", "vs",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
]);

export interface CleanedText {
  /** Cleaned value, trimmed and capped at the requested length. */
  readonly text: string;
  /** True when content was removed to satisfy `maxLength`. */
  readonly truncated: boolean;
  /** True when control or invisible formatting characters were removed. */
  readonly removedControlCharacters: boolean;
}

export interface CleanTextOptions {
  /** Collapse all whitespace (including line breaks) into single spaces. */
  readonly inline?: boolean;
}

/**
 * Normalise untrusted text for display.
 *
 * Order matters: Unicode normalisation first (so compatibility characters are
 * stable), then invisible-character removal, then typographic replacements,
 * then whitespace collapse and finally length limiting.
 */
export function cleanText(
  value: unknown,
  maxLength: number,
  options: CleanTextOptions = {},
): CleanedText {
  if (typeof value !== "string" || value.length === 0) {
    return { text: "", truncated: false, removedControlCharacters: false };
  }

  let normalized = value.normalize("NFKC").replace(/\r\n?/g, "\n");

  const withoutInvisible = normalized
    .replace(CONTROL_CHARACTERS, "")
    .replace(FORMAT_CHARACTERS, "");
  const removedControlCharacters = withoutInvisible.length !== normalized.length;
  normalized = withoutInvisible;

  for (const [pattern, replacement] of TYPOGRAPHIC_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }

  normalized = normalized.replace(HTML_ENTITY_PATTERN, (entity) => HTML_ENTITIES[entity] ?? entity);
  normalized = normalized.replace(EMOJI_SEQUENCE, "");

  if (options.inline) {
    normalized = normalized.replace(/\s+/g, " ");
  } else {
    normalized = normalized
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n");
  }

  normalized = normalized.trim();

  const text = truncateAtWord(normalized, maxLength);
  return {
    text,
    truncated: text.length < normalized.length,
    removedControlCharacters,
  };
}

/** Cut at a word boundary when possible, never exceeding `maxLength`. */
export function truncateAtWord(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;

  const candidate = value.slice(0, maxLength);
  const lastSpace = candidate.lastIndexOf(" ");
  const lastNewline = candidate.lastIndexOf("\n");
  const lastBreak = Math.max(lastSpace, lastNewline);
  if (lastBreak >= Math.floor(maxLength * 0.5)) {
    return candidate.slice(0, lastBreak).trimEnd();
  }
  return candidate.trimEnd();
}

/** Number of Unicode letters in a string (used to detect unusable titles). */
export function countLetters(value: string): number {
  return [...value].filter((character) => /\p{L}/u.test(character)).length;
}

/** Remove repeated "!!!"/"???" and spaces before punctuation. */
export function collapsePunctuation(value: string): string {
  return value
    .replace(/!{2,}/g, "!")
    .replace(/\?{2,}/g, "?")
    .replace(/\s+([!?.,;:])/g, "$1");
}

/**
 * Capitalise a string for use as a title.
 *
 * - all lowercase → title case ("kids craft fair" → "Kids Craft Fair")
 * - ALL CAPS → title case, preserving short acronyms ("BC SPCA FUNDRAISER"
 *   → "BC SPCA Fundraiser")
 * - anything else → only the first letter is capitalised, so mixed-case
 *   brands ("iPhone", "eBay") are left alone.
 */
export function normalizeTitleCapitalization(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  const letters = trimmed.replace(/[^\p{L}]/gu, "");
  if (!letters) return trimmed;

  const hasLowercase = /\p{Ll}/u.test(trimmed);
  const hasUppercase = /\p{Lu}/u.test(trimmed);

  if (!hasUppercase) return titleCase(trimmed, false);
  if (!hasLowercase && letters.length >= 3) return titleCase(trimmed, true);
  return capitalizeFirst(trimmed);
}

function titleCase(value: string, preserveAcronyms: boolean): string {
  return value
    .split(/(\s+)/)
    .map((part) => {
      if (!/\p{L}/u.test(part)) return part;

      if (preserveAcronyms) {
        const letters = part.replace(/[^\p{L}]/gu, "").toUpperCase();
        if (ACRONYMS.has(letters)) return part;
      }

      return capitaliseWord(part);
    })
    .join("");
}

function capitaliseWord(word: string): string {
  let seenLetter = false;
  let result = "";
  for (const character of word) {
    if (!/\p{L}/u.test(character)) {
      result += character;
      continue;
    }
    result += seenLetter ? character.toLowerCase() : character.toUpperCase();
    seenLetter = true;
  }
  return result;
}

function capitalizeFirst(value: string): string {
  const match = value.match(/\p{L}/u);
  if (!match || match.index === undefined) return value;
  return (
    value.slice(0, match.index) +
    match[0].toUpperCase() +
    value.slice(match.index + match[0].length)
  );
}

/**
 * First sentence of `text`, collapsed to one line and capped at `maxLength`
 * (an ellipsis is included in the cap). Returns null for empty text.
 *
 * This is extraction, not generation: the returned characters always come from
 * the source text.
 */
export function firstSentence(text: string, maxLength: number): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const firstEnd = findSentenceEnd(trimmed);
  let sentence = firstEnd === -1 ? trimmed : trimmed.slice(0, firstEnd);

  // Very short openers ("Join us!") make poor summaries; extend by one sentence.
  if (firstEnd !== -1 && sentence.length < 20) {
    const rest = trimmed.slice(firstEnd).trimStart();
    if (rest) {
      const secondEnd = findSentenceEnd(rest);
      const extra = secondEnd === -1 ? rest.length : secondEnd;
      sentence = `${sentence} ${rest.slice(0, extra)}`.trim();
    }
  }

  sentence = sentence.replace(/\s+/g, " ").trim();
  if (!sentence) return null;

  if (sentence.length > maxLength) {
    const shortened = truncateAtWord(sentence, Math.max(1, maxLength - 1)).trimEnd();
    return `${shortened}…`;
  }
  return sentence;
}

function findSentenceEnd(text: string): number {
  const pattern = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(Math.max(0, match.index - 16), match.index);
    const word = before.match(/([\p{L}.]+)$/u)?.[1] ?? "";
    const normalized = word.toLowerCase().replace(/\.+$/, "");
    if (word.length === 1 && /\p{L}/u.test(word)) continue;
    if (SENTENCE_ABBREVIATIONS.has(normalized)) continue;
    return match.index + 1;
  }
  return -1;
}
