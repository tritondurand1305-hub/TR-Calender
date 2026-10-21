/**
 * `rules-v1` — the deterministic, dependency-free normaliser.
 *
 * What it does: cleans text, validates supplied structured values, classifies
 * into the five approved categories when the caller did not supply one,
 * extracts only explicitly supported facts (cost, public contact, registration
 * link, hashtags) and records every uncertainty as a review flag.
 *
 * What it deliberately does not do (Phase 1):
 *  - parse dates or times out of free text;
 *  - resolve relative expressions ("this Saturday") or infer a year;
 *  - invent a time, an end time, or an all-day flag;
 *  - decide a category with confidence from a single weak keyword;
 *  - publish, approve, persist or call any network service.
 */

import {
  cleanText,
  collapsePunctuation,
  countLetters,
  firstSentence,
  normalizeTitleCapitalization,
} from "./text.ts";
import {
  DRAFT_FIELDS,
  EVENT_CATEGORIES,
  LIMITS,
  NORMALIZER_VERSION,
  REVIEW_FLAG_CODES,
  REVIEW_FLAG_MESSAGES,
  REVIEW_FLAG_QUESTIONS,
  canonicalIsoTimestamp,
  isValidHttpUrl,
} from "./types.ts";
import type {
  DraftField,
  EventCategory,
  NormalizedEventDraft,
  NormalizerContext,
  NormalizerInput,
  NormalizerProvider,
  ReviewFlag,
  ReviewFlagCode,
} from "./types.ts";
import type { CleanedText } from "./text.ts";

/* -------------------------------------------------------------------------- */
/* Flags and questions                                                         */
/* -------------------------------------------------------------------------- */

const REVIEW_FLAG_CODE_ORDER: ReadonlyArray<string> = REVIEW_FLAG_CODES;

function addFlag(flags: ReviewFlag[], code: ReviewFlagCode): void {
  if (!flags.some((flag) => flag.code === code)) {
    flags.push({ code, message: REVIEW_FLAG_MESSAGES[code] });
  }
}

/* -------------------------------------------------------------------------- */
/* Text patterns                                                               */
/* -------------------------------------------------------------------------- */

const RELATIVE_DATE_PATTERN =
  /\b(?:today|tonight|tomorrow|yesterday|this\s+(?:morning|afternoon|evening|week|weekend|month)|next\s+(?:week|weekend|month|year)|(?:this|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in\s+\d+\s+(?:days?|weeks?))\b/i;

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const DATE_EXPRESSION_PATTERN = new RegExp(
  [
    `\\b${MONTH}\\s+\\d{1,2}\\b`,
    `\\b\\d{1,2}\\s+${MONTH}\\b`,
    "\\b\\d{4}-\\d{2}-\\d{2}\\b",
    // Numeric month/day with an optional year. The ranges are what separate a
    // date from a fundraiser split: "10/24" and "10/24/2026" match, "50/50"
    // and "75/25" do not. Only detection happens here — nothing is converted.
    "\\b(?:0?[1-9]|1[0-2])/(?:0?[1-9]|[12]\\d|3[01])(?:/\\d{2,4})?\\b",
  ].join("|"),
  "i",
);

const INSTRUCTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?|prompts?)\b/i,
  /\bsystem\s*(?:prompt|message|instructions?)\b/i,
  /\byou\s+are\s+(?:now\s+)?an?\s+(?:ai|assistant|language model|chatbot)\b/i,
  /\bas\s+an\s+ai\s+(?:language\s+)?model\b/i,
  /\bprompt\s+injection\b/i,
];

const SAFETY_PATTERNS: ReadonlyArray<RegExp> = [
  /\broad\s+(?:closure|closed|work)\b/i,
  /\bevacuat(?:e|ion)\b/i,
  /\bwildfire\b/i,
  /\bflood\s+(?:warning|watch)\b/i,
  /\b(?:missing\s+person|amber\s+alert)\b/i,
  /\bscam\s+alert\b/i,
  /\bboil\s+water\s+advisory\b/i,
];

/** Sentences (and lines) are the unit of cost and contact context. */
const SEGMENT_SPLIT = /(?<=[.!?;])\s+|\n+/;

/** Words that make a dollar amount an admission price. */
const ADMISSION_COST_CONTEXT =
  /\b(?:admission|entry|entrance|tickets?|cover(?:\s+charge)?|at\s+the\s+door|prices?|priced|costs?|fees?|per\s+(?:person|ticket|guest|child|adult)|general\s+admission|advance|admits?|passes?)\b/i;

/** Words that make a dollar amount something other than an admission price. */
const NON_ADMISSION_COST_CONTEXT =
  /\b(?:fundrais(?:er|ing)|proceeds?|raise|raised|raising|goal|donat(?:e|ed|ing|ion|ions)?|prizes?|gift\s+cards?|vouchers?|value|worth|save|savings|discount|coupons?|off|rebate|refund|deposit|invoice|budget|grant|raffle|50\/50|split\s+the\s+pot|suggested|sliding\s+scale|pay\s+what\s+you\s+can|parking|snacks?|drinks?|refreshments?|coffee|popcorn|hot\s+dogs?|swag|merch)\b/i;

/** A dollar amount. Bare amounts are never promoted without admission context. */
const DOLLAR_AMOUNT = /\$\s?(\d{1,4}(?:\.\d{2})?)/g;

/** `free`, `no charge`, `no cost`, but not part of a hyphenated compound. */
const FREE_CLAIM = /(?<![-\p{L}])(?:free|no[-\s]?charge|no[-\s]?cost)(?![-\p{L}])/iu;

const FREE_NEGATED =
  /\b(?:not|never|isn't|aren't|wasn't|weren't|no\s+longer)\s+(?:free|no[-\s]?charge|no[-\s]?cost)\b/i;

/** "free for students" is a discount, not free admission for everyone. */
const FREE_SUBGROUP =
  /\b(?:free|no[-\s]?charge|no[-\s]?cost)\s+(?:for|to)\s+(?:kids?|children|youth|teens?|students?|seniors?|elders?|members?|veterans?|families|family|adults?|accompanied|under\s+\d+|ages?\s+\d+)/i;

/** "free parking", "free snacks": real, but not admission. */
const FREE_UNRELATED =
  /\b(?:free|no[-\s]?charge|no[-\s]?cost)\s+(?:parking|transit|shuttle|wifi|wi-fi|coffee|tea|snacks?|food|drinks?|refreshments?|popcorn|hot\s+dogs?|childcare|child\s+care|babysitting|swag|t-shirts?|gifts?|samples?|merch)\b/i;

/** `Admission is free`, `Tickets: free`. The copula or colon is required. */
const ADMISSION_FREE_BEFORE =
  /\b(?:admission|entry|entrance|tickets?|registration|cover|the\s+event|this\s+event|event|workshop|concert|show|class|program|drop[-\s]?in|festival|fair|market)\b[^.!?;\n]{0,24}\b(?:(?:is|are|will\s+be)\s+|:\s*)(?:free|no\s+charge|no\s+cost)\b/i;

/** `Free admission`, `free event`. */
const ADMISSION_FREE_AFTER =
  /(?<![-\p{L}])(?:free|no\s+charge|no\s+cost)\s+(?:admission|entry|entrance|tickets?|event|workshop|concert|show|class|program|drop[-\s]?in|festival|fair|market|movie|dance|dinner|breakfast|lunch|bbq|barbecue)\b/iu;

/** A segment that is only "Free". */
const FREE_ONLY_SEGMENT = /^\s*(?:free|no\s+charge|no\s+cost)\s*[!.]?\s*$/i;

const DONATION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bby donation\b/i,
  /\bpay what you can\b/i,
  /\bdonations?\s+(?:are\s+)?(?:accepted|welcome|appreciated)\b/i,
];

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_PATTERN =
  /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const CONTACT_FRAME =
  /\b(?:contact|email|e-mail|call|phone|text|questions?|info|register|rsvp|reach)\b/i;
/** First-person wording marks a personal contact detail, not a public one. */
const PERSONAL_CONTACT = /\b(?:me|my|mine|myself)\b/i;

const URL_CANDIDATE =
  /(?<!\w)(?:https?:\/\/[^\s<>"')\]]+|(?:javascript|data|file|ftp):[^\s<>"')\]]+|www\.[^\s<>"')\]]+)/gi;
const REGISTRATION_LABEL =
  /\b(?:register|registration|rsvp|sign[ -]?up|reserve|booking|tickets?)\b/gi;
/** `Register:` as the last thing on a line, with the link on the next line. */
const REGISTRATION_LABEL_AT_END =
  /(?:register|registration|rsvp|sign[ -]?up|reserve|booking|tickets?)\s*:?\s*$/i;
/** Between a registration label and a link, these mean "not a sign-up link". */
const INFORMATION_LABEL =
  /\b(?:more\s+info|info|information|details|source|learn\s+more|website|webpage|event\s+page|see)\b/i;

const HASHTAG_PATTERN = /#([\p{L}\p{N}_-]{1,40})/gu;

/* -------------------------------------------------------------------------- */
/* Category inference                                                          */
/* -------------------------------------------------------------------------- */

const CATEGORY_KEYWORDS: Readonly<Record<EventCategory, readonly string[]>> = {
  "Community Events": [
    "festival", "fair", "market", "concert", "performance", "celebration", "parade",
    "workshop", "gathering", "dance", "dinner", "breakfast", "lunch", "barbecue", "bbq",
    "party", "movie", "fundraiser", "auction", "pancake", "craft sale", "bake sale",
  ],
  "Families & Youth": [
    "family", "families", "kids", "kid", "children", "child", "youth", "teen", "teens",
    "toddler", "baby", "parent", "parents", "playgroup", "storytime", "story time", "camp",
  ],
  "Sports & Recreation": [
    "sports", "sport", "hockey", "soccer", "baseball", "softball", "basketball", "volleyball",
    "swimming", "swim", "skating", "skate", "curling", "fitness", "yoga", "hiking", "hike",
    "cycling", "pickleball", "tennis", "golf", "recreation", "drop-in", "tournament", "fun run",
  ],
  "Seniors & Services": [
    "seniors", "senior", "elders", "retirement", "caregiver", "caregivers", "support group",
    "food bank", "health clinic", "vaccination", "legal aid", "counselling", "counseling",
    "resource centre", "resource center",
  ],
  "Community Notices": [
    "notice", "road closure", "road work", "closure", "cancelled", "cancellation",
    "office closed", "public information", "volunteer", "volunteers", "meeting", "agm",
    "city council", "registration open", "deadline",
  ],
};

interface CategoryGuess {
  readonly category: EventCategory;
  readonly score: number;
}

function matchesKeyword(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function inferCategory(text: string): CategoryGuess | null {
  if (!text) return null;

  let best: CategoryGuess | null = null;
  for (const category of EVENT_CATEGORIES) {
    let score = 0;
    for (const keyword of CATEGORY_KEYWORDS[category]) {
      if (matchesKeyword(text, keyword)) score += 1;
    }
    if (score > 0 && (best === null || score > best.score)) {
      best = { category, score };
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Field normalisation                                                         */
/* -------------------------------------------------------------------------- */

function normalizeTitle(
  raw: string | null,
  flags: ReviewFlag[],
  changed: Set<DraftField>,
): string | null {
  if (raw === null) {
    addFlag(flags, "missing_title");
    return null;
  }

  const cleaned = cleanText(raw, LIMITS.titleMax, { inline: true });
  if (cleaned.truncated) addFlag(flags, "truncated_input");

  const titled = normalizeTitleCapitalization(collapsePunctuation(cleaned.text).trim()).trim();
  const letters = countLetters(titled);

  if (letters === 0) {
    addFlag(flags, "missing_title");
  } else if (letters < LIMITS.titleMin) {
    addFlag(flags, "title_too_short");
  }

  const value = letters >= LIMITS.titleMin ? titled : null;
  if (value !== raw) changed.add("title");
  return value;
}

function normalizeInlineField(
  raw: string | null,
  maxLength: number,
  field: DraftField,
  flags: ReviewFlag[],
  changed: Set<DraftField>,
): string | null {
  if (raw === null) return null;

  const cleaned = cleanText(raw, maxLength, { inline: true });
  if (cleaned.truncated) addFlag(flags, "truncated_input");

  const value = collapsePunctuation(cleaned.text).trim();
  if (!value) return null;
  if (value !== raw) changed.add(field);
  return value;
}

function normalizeTimestamp(
  raw: string | null,
  code: "invalid_start_at" | "invalid_end_at",
  flags: ReviewFlag[],
): string | null {
  if (raw === null) return null;
  const canonical = canonicalIsoTimestamp(raw);
  if (canonical === null) {
    addFlag(flags, code);
    return null;
  }
  return canonical;
}

function normalizeCategory(
  raw: string | null,
  searchText: string,
  flags: ReviewFlag[],
  changed: Set<DraftField>,
): EventCategory {
  const guess = inferCategory(searchText);

  if (raw !== null) {
    const supplied = EVENT_CATEGORIES.find(
      (candidate) => candidate.toLowerCase() === raw.toLowerCase(),
    );
    if (supplied) {
      if (supplied !== raw) changed.add("category");
      return supplied;
    }

    addFlag(flags, "category_uncertain");
    const fallback: EventCategory = guess?.category ?? "Community Events";
    if (fallback !== raw) changed.add("category");
    return fallback;
  }

  if (guess && guess.score >= 2) return guess.category;

  addFlag(flags, "category_uncertain");
  return guess?.category ?? "Community Events";
}

function combineBody(input: NormalizerInput): CleanedText {
  const details = input.details ?? "";
  const rawText = input.rawText ?? "";

  let combined = details;
  if (rawText) {
    if (!details || rawText.includes(details)) {
      combined = rawText;
    } else if (details.includes(rawText)) {
      combined = details;
    } else {
      combined = `${details}\n\n${rawText}`;
    }
  }

  return cleanText(combined, LIMITS.descriptionMax);
}

/* -------------------------------------------------------------------------- */
/* Extraction                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Classify a segment's free/charge wording.
 *
 * `admission` means the whole event is free. `other` covers everything else
 * (compound adjectives such as "smoke-free", unrelated freebies, discounted
 * groups, negations). `null` means the segment says nothing about free entry.
 */
function classifyFree(segment: string): "admission" | "other" | null {
  if (!FREE_CLAIM.test(segment)) return null;
  if (FREE_NEGATED.test(segment)) return "other";
  if (FREE_ONLY_SEGMENT.test(segment)) return "admission";
  if (FREE_SUBGROUP.test(segment)) return "other";
  if (FREE_UNRELATED.test(segment)) return "other";
  if (ADMISSION_FREE_BEFORE.test(segment) || ADMISSION_FREE_AFTER.test(segment)) {
    return "admission";
  }
  return "other";
}

/**
 * Extract only an explicitly stated cost.
 *
 * Rules (Phase 1):
 *  - a dollar amount needs admission/ticket/entry/fee/cover context nearby;
 *  - fundraising targets, discounts, prizes and deposits are not prices;
 *  - "free" counts only when it describes admission for everyone;
 *  - a fixed price plus a free subgroup keeps the price;
 *  - two different prices, or a free claim and a fixed price together, are
 *    ambiguous: return null and flag rather than guess.
 */
function extractCost(text: string, flags: ReviewFlag[]): string | null {
  let admissionFree = false;
  let donation = false;
  const prices: string[] = [];

  for (const segment of text.split(SEGMENT_SPLIT)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    if (classifyFree(trimmed) === "admission") admissionFree = true;
    if (DONATION_PATTERNS.some((pattern) => pattern.test(trimmed))) donation = true;

    for (const match of trimmed.matchAll(DOLLAR_AMOUNT)) {
      const index = match.index ?? 0;
      const before = trimmed.slice(Math.max(0, index - 48), index);
      const after = trimmed.slice(index + match[0].length, index + match[0].length + 32);
      const context = `${before} ${after}`;

      const admissionContext =
        ADMISSION_COST_CONTEXT.test(context) || ADMISSION_COST_CONTEXT.test(trimmed);
      if (!admissionContext) continue;
      if (NON_ADMISSION_COST_CONTEXT.test(context)) continue;

      prices.push(`$${match[1]}`);
    }
  }

  const distinct = [...new Set(prices)];

  if (distinct.length > 1 || (distinct.length === 1 && admissionFree)) {
    addFlag(flags, "cost_ambiguous");
    return null;
  }
  if (distinct.length === 1) return distinct[0] as string;
  if (admissionFree) return "Free";
  if (donation) return "By donation";
  return null;
}

/**
 * The context immediately before `index`, bounded by the start of the
 * sentence and of the line. This keeps a public organizer email from making a
 * personal phone number elsewhere in the paragraph look publishable.
 */
function localContext(text: string, index: number, distance: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  let sentenceStart = 0;
  for (const boundary of [". ", "! ", "? ", "; ", ".\n", "!\n", "?\n"]) {
    const at = text.lastIndexOf(boundary, index - 1);
    if (at >= 0) sentenceStart = Math.max(sentenceStart, at + boundary.length);
  }
  return text.slice(Math.max(lineStart, sentenceStart, index - distance), index);
}

/**
 * Extract contact details only when each one is individually framed as public.
 *
 * Every phone and email is evaluated on its own local context. First-person
 * wording ("call me", "my cell") is never promoted. An over-long value is
 * dropped with a flag instead of failing the whole normalisation.
 */
function extractContact(text: string, flags: ReviewFlag[]): string | null {
  const selected: string[] = [];

  const consider = (value: string, index: number): void => {
    const before = localContext(text, index, 80);
    const framed = CONTACT_FRAME.test(before) && !PERSONAL_CONTACT.test(before);
    if (!framed) {
      addFlag(flags, "contact_not_public");
      return;
    }

    const joined = [...selected, value].join(" | ");
    if (joined.length > LIMITS.contactMax) {
      addFlag(flags, "contact_invalid");
      return;
    }
    selected.push(value);
  };

  for (const match of text.matchAll(EMAIL_PATTERN)) consider(match[0], match.index ?? 0);
  for (const match of text.matchAll(PHONE_PATTERN)) consider(match[0], match.index ?? 0);

  return selected.length > 0 ? selected.join(" | ") : null;
}

/**
 * Text between the nearest registration label and a URL, or null when the URL
 * has no registration label of its own (for example a link introduced by
 * "More info:", or a link that merely shares a paragraph with "register").
 *
 * Two shapes are supported: a label on the same line (`Register: <url>`) and a
 * label that ends the previous line (`Register:` then a URL line).
 */
function registrationConnector(text: string, index: number): string | null {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const beforeOnLine = text.slice(lineStart, index);

  if (beforeOnLine.trim().length === 0) {
    const priorText = text.slice(0, lineStart).replace(/[ \t\r\n]+$/g, "");
    const priorLineStart = priorText.lastIndexOf("\n") + 1;
    const priorLine = priorText.slice(priorLineStart);
    const tail = REGISTRATION_LABEL_AT_END.exec(priorLine);
    if (!tail || tail.index === undefined) return null;
    return priorLine.slice(0, tail.index);
  }

  const labels = [...beforeOnLine.matchAll(REGISTRATION_LABEL)];
  const last = labels[labels.length - 1];
  if (!last || last.index === undefined) return null;
  return beforeOnLine.slice(last.index + last[0].length);
}

function extractRegistrationUrl(
  text: string,
  sourceUrl: string | null,
  flags: ReviewFlag[],
): string | null {
  const candidates: string[] = [];
  let sawInvalid = false;
  let sawAmbiguous = false;

  for (const match of text.matchAll(URL_CANDIDATE)) {
    const index = match.index ?? 0;
    const candidate = match[0].replace(/[.,;:!?]+$/, "");

    const connector = registrationConnector(text, index);
    if (connector === null) continue;

    if (!isValidHttpUrl(candidate)) {
      sawInvalid = true;
      continue;
    }
    if (candidate === sourceUrl) continue;

    const unambiguous =
      connector.length <= 48 &&
      !/[.!?]/.test(connector) &&
      !INFORMATION_LABEL.test(connector);
    if (!unambiguous) {
      sawAmbiguous = true;
      continue;
    }
    candidates.push(candidate);
  }

  if (sawInvalid) addFlag(flags, "invalid_registration_url");

  const distinct = [...new Set(candidates)];
  if (distinct.length === 1) return distinct[0] as string;
  if (distinct.length > 1) {
    addFlag(flags, "registration_url_ambiguous");
    return null;
  }
  if (sawAmbiguous) addFlag(flags, "registration_url_ambiguous");
  return null;
}

function extractTags(text: string, flags: ReviewFlag[]): string[] {
  const tags: string[] = [];

  for (const match of text.matchAll(HASHTAG_PATTERN)) {
    const tag = (match[1] ?? "").replace(/^[-_]+/, "").replace(/[-_]+$/, "").toLowerCase();
    if (tag && !tags.includes(tag)) tags.push(tag);
  }

  if (tags.length > LIMITS.tagsMax) {
    addFlag(flags, "truncated_input");
    return tags.slice(0, LIMITS.tagsMax);
  }
  return tags;
}

/* -------------------------------------------------------------------------- */
/* Draft assembly                                                              */
/* -------------------------------------------------------------------------- */

function buildDraft(input: NormalizerInput, referenceTime: string): NormalizedEventDraft {
  // Phase 1 never derives a date from the reference clock: relative
  // expressions are flagged, not resolved. The value is kept in the signature
  // so a future phase can use it without changing call sites.
  void referenceTime;

  const flags: ReviewFlag[] = [];
  const changed = new Set<DraftField>();

  const title = normalizeTitle(input.title, flags, changed);
  const body = combineBody(input);
  const searchText = title ? `${title}\n${body.text}` : body.text;

  if (body.truncated) addFlag(flags, "truncated_input");

  const startAt = normalizeTimestamp(input.startAt, "invalid_start_at", flags);
  const endAt = normalizeTimestamp(input.endAt, "invalid_end_at", flags);
  if (input.startAt !== null && input.startAt !== startAt) changed.add("startAt");
  if (input.endAt !== null && input.endAt !== endAt) changed.add("endAt");

  if (startAt === null) addFlag(flags, "missing_date");
  if (startAt !== null && endAt !== null && Date.parse(endAt) < Date.parse(startAt)) {
    addFlag(flags, "end_before_start");
  }

  const category = normalizeCategory(input.category, searchText, flags, changed);
  const summary = firstSentence(body.text, LIMITS.summaryMax);
  const description = body.text.length > 0 ? body.text : null;

  const location = normalizeInlineField(
    input.location,
    LIMITS.locationMax,
    "location",
    flags,
    changed,
  );
  if (location === null) addFlag(flags, "missing_location");

  const organizer = normalizeInlineField(
    input.organizer,
    LIMITS.organizerMax,
    "organizer",
    flags,
    changed,
  );

  let sourceUrl = input.sourceUrl;
  if (sourceUrl !== null && !isValidHttpUrl(sourceUrl)) {
    addFlag(flags, "invalid_source_url");
    sourceUrl = null;
  }
  if (input.sourceUrl !== null && input.sourceUrl !== sourceUrl) changed.add("sourceUrl");

  const contact = extractContact(searchText, flags);
  const cost = extractCost(searchText, flags);
  if (cost === null) addFlag(flags, "cost_unclear");

  const registrationUrl = extractRegistrationUrl(body.text, sourceUrl, flags);
  const tags = extractTags(body.text, flags);

  if (input.duplicatePotential) addFlag(flags, "duplicate_potential");

  const hasRelativeDate = RELATIVE_DATE_PATTERN.test(searchText);
  if (hasRelativeDate) addFlag(flags, "relative_date_unresolved");
  // A date-like expression in prose is never converted in Phase 1. Flag it even
  // when a structured date exists: the reviewer is asked to confirm that the
  // two agree. The flag never claims a conflict, because no comparison is made.
  if (!hasRelativeDate && DATE_EXPRESSION_PATTERN.test(searchText)) {
    addFlag(flags, "date_expression_unresolved");
  }

  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(searchText))) {
    addFlag(flags, "instruction_like_text");
  }
  if (SAFETY_PATTERNS.some((pattern) => pattern.test(searchText))) {
    addFlag(flags, "safety_sensitive");
  }

  flags.sort(
    (left, right) =>
      REVIEW_FLAG_CODE_ORDER.indexOf(left.code) - REVIEW_FLAG_CODE_ORDER.indexOf(right.code),
  );

  const unresolvedQuestions = flags
    .map((flag) => REVIEW_FLAG_QUESTIONS[flag.code])
    .filter((question, index, all) => all.indexOf(question) === index)
    .slice(0, LIMITS.questionsMax);

  const changedFields = DRAFT_FIELDS.filter((field) => changed.has(field));

  return {
    title,
    category,
    summary,
    description,
    startAt,
    endAt,
    allDay: input.allDay,
    location,
    organizer,
    contact,
    cost,
    registrationUrl,
    sourceUrl,
    tags,
    reviewFlags: flags,
    changedFields,
    unresolvedQuestions,
  };
}

/**
 * Deterministic provider. It is async to satisfy the provider-neutral
 * interface, but contains no I/O.
 */
export const rulesNormalizer: NormalizerProvider = {
  id: "rules",
  version: NORMALIZER_VERSION,
  async normalize(
    input: NormalizerInput,
    context: NormalizerContext,
  ): Promise<NormalizedEventDraft> {
    return buildDraft(input, context.referenceTime);
  },
};
