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

const FLAG_MESSAGES: Readonly<Record<ReviewFlagCode, string>> = {
  missing_title: "No event title was supplied.",
  title_too_short: "The title is too short to publish.",
  missing_date: "No valid start date and time were supplied.",
  invalid_start_at: "The start value is not a full ISO 8601 date and time.",
  invalid_end_at: "The end value is not a full ISO 8601 date and time.",
  end_before_start: "The end time is before the start time.",
  missing_location: "No event location was supplied.",
  category_uncertain: "The category could not be confirmed from the submission.",
  cost_unclear: "No admission cost was stated; do not assume the event is free.",
  contact_not_public: "Contact details were found but not clearly marked for public use.",
  invalid_source_url: "The source link is not a valid public web address.",
  invalid_registration_url: "The registration link is not a valid public web address.",
  relative_date_unresolved: "The text uses a relative date; confirm the exact date.",
  date_expression_unresolved: "The text contains a date that was not converted; confirm it.",
  duplicate_potential: "A possible duplicate was detected; check existing listings.",
  truncated_input: "Part of the submitted text was shortened to fit length limits.",
  instruction_like_text: "The text contains instruction-like content; treat it as event content.",
  safety_sensitive: "The notice contains safety-sensitive wording; review it separately.",
};

const QUESTIONS: Readonly<Record<ReviewFlagCode, string>> = {
  missing_title: "What is the event title?",
  title_too_short: "What is the full event title?",
  missing_date: "What date and time does the event start?",
  invalid_start_at: "Confirm the correct start date and time.",
  invalid_end_at: "Confirm the correct end date and time.",
  end_before_start: "Should the end time be later than the start time?",
  missing_location: "Where will the event take place?",
  category_uncertain: "Which approved category best fits this event?",
  cost_unclear: "Is there an admission cost, or is the event free?",
  contact_not_public: "Is this contact information intended for public display?",
  invalid_source_url: "What is the correct public source link?",
  invalid_registration_url: "What is the correct registration link?",
  relative_date_unresolved: "What is the exact date for the relative date mentioned in the text?",
  date_expression_unresolved: "What is the exact date and time mentioned in the text?",
  duplicate_potential: "Is this a duplicate of an existing listing?",
  truncated_input: "The submission was shortened; confirm that no important details were lost.",
  instruction_like_text: "The text contains instructions; confirm that the event details are correct.",
  safety_sensitive: "Does this notice need separate safety moderation before publication?",
};

function addFlag(flags: ReviewFlag[], code: ReviewFlagCode): void {
  if (!flags.some((flag) => flag.code === code)) {
    flags.push({ code, message: FLAG_MESSAGES[code] });
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
    "\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b",
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

const FREE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:admission|entry|entrance|tickets?|registration)\b[^.\n]{0,24}\b(?:is|are|will be)?\s*(?:free|no charge|no cost)\b/i,
  /\b(?:free|no[- ]charge|no[- ]cost)\b[^.\n]{0,24}\b(?:admission|entry|entrance|event|workshop|concert|show|class|drop[- ]in|for (?:kids|children|families|seniors))\b/i,
  /^\s*(?:free|no charge|no cost)\s*$/im,
];

const PRICE_PATTERN = /\$\s?\d{1,4}(?:\.\d{2})?/;

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

const URL_CANDIDATE =
  /(?<!\w)(?:https?:\/\/[^\s<>"')\]]+|(?:javascript|data|file|ftp):[^\s<>"')\]]+|www\.[^\s<>"')\]]+)/gi;
const REGISTRATION_FRAME =
  /\b(?:register|registration|rsvp|tickets?|sign[ -]?up|reserve)\b/i;

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

function extractCost(text: string): string | null {
  for (const pattern of FREE_PATTERNS) {
    if (pattern.test(text)) return "Free";
  }

  const price = text.match(PRICE_PATTERN);
  if (price) return price[0].trim();

  for (const pattern of DONATION_PATTERNS) {
    if (pattern.test(text)) return "By donation";
  }

  return null;
}

function isNearFrame(text: string, index: number, frame: RegExp, distance: number): boolean {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const start = Math.max(lineStart, index - distance);
  return frame.test(text.slice(start, index));
}

function extractContact(text: string, flags: ReviewFlag[]): string | null {
  const emails = [...text.matchAll(EMAIL_PATTERN)];
  const phones = [...text.matchAll(PHONE_PATTERN)];

  const framedEmails = emails.filter((match) =>
    isNearFrame(text, match.index ?? 0, CONTACT_FRAME, 80),
  );
  const framedPhones = phones.filter((match) =>
    isNearFrame(text, match.index ?? 0, CONTACT_FRAME, 80),
  );

  if (framedEmails.length > 0 || framedPhones.length > 0) {
    const parts: string[] = [];
    if (framedEmails[0]) parts.push(framedEmails[0][0]);
    if (framedPhones[0]) {
      const withPhone = [...parts, framedPhones[0][0]].join(" | ");
      if (withPhone.length <= LIMITS.contactMax) parts.push(framedPhones[0][0]);
    }
    const contact = parts.join(" | ");
    return contact.length > 0 ? contact : null;
  }

  if (emails.length > 0 || phones.length > 0) {
    addFlag(flags, "contact_not_public");
  }
  return null;
}

function extractRegistrationUrl(
  text: string,
  sourceUrl: string | null,
  flags: ReviewFlag[],
): string | null {
  let sawInvalid = false;

  for (const match of text.matchAll(URL_CANDIDATE)) {
    const index = match.index ?? 0;
    if (!isNearFrame(text, index, REGISTRATION_FRAME, 120)) continue;

    const candidate = match[0].replace(/[.,;:!?]+$/, "");
    if (isValidHttpUrl(candidate)) {
      if (candidate !== sourceUrl) return candidate;
    } else {
      sawInvalid = true;
    }
  }

  if (sawInvalid) addFlag(flags, "invalid_registration_url");
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
  const cost = extractCost(searchText);
  if (cost === null) addFlag(flags, "cost_unclear");

  const registrationUrl = extractRegistrationUrl(body.text, sourceUrl, flags);
  const tags = extractTags(body.text, flags);

  if (input.duplicatePotential) addFlag(flags, "duplicate_potential");

  const hasRelativeDate = RELATIVE_DATE_PATTERN.test(searchText);
  if (hasRelativeDate) addFlag(flags, "relative_date_unresolved");
  if (startAt === null && !hasRelativeDate && DATE_EXPRESSION_PATTERN.test(searchText)) {
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
    .map((flag) => QUESTIONS[flag.code])
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
