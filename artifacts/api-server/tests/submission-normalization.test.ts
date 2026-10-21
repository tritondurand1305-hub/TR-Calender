/**
 * Integration tests for the submission → normalizer seam.
 *
 * Run from `artifacts/api-server` with: node --test tests/*.test.ts
 *
 * No database is needed: `normalizeAndStore` receives the write function as a
 * parameter, so the exact code path the submission route uses can be tested,
 * including a failing write.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NORMALIZATION_ERROR_CODES,
  STORED_NORMALIZATION_STATUSES,
  normalizeAndStore,
  normalizeSubmission,
  persistNormalization,
  readStoredNormalization,
  toNormalizerInput,
} from "../src/lib/submissionNormalization.ts";
import type { SubmissionNormalizationSource } from "../src/lib/submissionNormalization.ts";
import type { NormalizerProvider } from "../src/lib/normalizer/index.ts";

const CREATED_AT = new Date("2026-10-20T18:00:00.000Z");
const PRIVATE_EMAIL = "private.organizer@example.org";

function source(
  overrides: Partial<SubmissionNormalizationSource> = {},
): SubmissionNormalizationSource {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Community Pancake Breakfast",
    category: "Community Events",
    startAt: new Date("2026-11-07T17:00:00.000Z"),
    endAt: new Date("2026-11-07T19:00:00.000Z"),
    allDay: false,
    location: "Tumbler Ridge Community Centre",
    details: "Join us for pancakes, sausages and coffee. Admission is free. All ages welcome.",
    organizer: "Tumbler Ridge Lions Club",
    sourceUrl: "https://example.org/events/pancakes",
    duplicatePotential: false,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/** A row as it comes out of the database, including private columns. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    ...source(),
    followUpEmail: PRIVATE_EMAIL,
    status: "pending",
    normalizationStatus: "not_run",
    normalizerVersion: null,
    normalizationReferenceTime: null,
    normalizationErrorCode: null,
    normalizedDraft: null,
    ...overrides,
  };
}

describe("submission normalization seam", () => {
  it("maps only the fields the normalizer is allowed to see", () => {
    const input = toNormalizerInput(storedRow());

    assert.deepEqual(Object.keys(input).sort(), [
      "allDay",
      "category",
      "details",
      "duplicatePotential",
      "endAt",
      "location",
      "organizer",
      "rawText",
      "sourceUrl",
      "startAt",
      "title",
    ]);
    assert.equal(input.startAt, "2026-11-07T17:00:00.000Z");
    assert.equal(input.endAt, "2026-11-07T19:00:00.000Z");
    assert.equal(input.rawText, null);
    assert.ok(!JSON.stringify(input).includes(PRIVATE_EMAIL));
  });

  it("normalizes a valid submission and writes the result beside the raw row", async () => {
    const row = Object.freeze(storedRow());
    const values = await normalizeSubmission(row);

    assert.equal(values.normalizationStatus, "normalized");
    assert.equal(values.normalizerVersion, "rules-v1");
    assert.equal(values.normalizationErrorCode, null);
    assert.equal(values.normalizationReferenceTime?.toISOString(), CREATED_AT.toISOString());

    const draft = values.normalizedDraft;
    assert.ok(draft);
    assert.equal(draft.title, "Community Pancake Breakfast");
    assert.equal(draft.cost, "Free");
    assert.equal(draft.startAt, "2026-11-07T17:00:00.000Z");
    assert.deepEqual(draft.reviewFlags, []);

    // The private follow-up address can never reach the draft or any column.
    assert.ok(!JSON.stringify(values).includes(PRIVATE_EMAIL));

    // The row itself is untouched.
    assert.equal(row.followUpEmail, PRIVATE_EMAIL);
    assert.equal(row.title, "Community Pancake Breakfast");
  });

  it("records flags instead of inventing values", async () => {
    const values = await normalizeSubmission(
      source({
        title: null,
        category: null,
        startAt: null,
        endAt: null,
        location: null,
        details: "Bring the family. Tickets are $10; free for students.",
        organizer: null,
        sourceUrl: null,
      }),
    );

    assert.equal(values.normalizationStatus, "needs_review");
    assert.ok(values.normalizedDraft);
    assert.equal(values.normalizedDraft.title, null);
    assert.equal(values.normalizedDraft.startAt, null);
    for (const code of ["missing_title", "missing_date", "missing_location", "category_uncertain"]) {
      assert.ok(
        values.normalizedDraft.reviewFlags.some((flag) => flag.code === code),
        `expected ${code}`,
      );
    }
  });

  it("never throws and never stores a draft when the provider fails", async () => {
    const throwing: NormalizerProvider = {
      id: "test-throw",
      version: "test-throw-1",
      async normalize() {
        throw new Error("provider exploded: private.organizer@example.org");
      },
    };
    const failed = await normalizeSubmission(storedRow(), throwing);
    assert.equal(failed.normalizationStatus, "failed");
    assert.equal(failed.normalizationErrorCode, "internal_error");
    assert.equal(failed.normalizedDraft, null);
    assert.equal(failed.normalizationReferenceTime?.toISOString(), CREATED_AT.toISOString());

    const invalid: NormalizerProvider = {
      id: "test-invalid",
      version: "test-invalid-1",
      async normalize() {
        return { title: 42 } as never;
      },
    };
    const rejected = await normalizeSubmission(storedRow(), invalid);
    assert.equal(rejected.normalizationStatus, "failed");
    assert.equal(rejected.normalizationErrorCode, "invalid_provider_output");
    assert.equal(rejected.normalizedDraft, null);

    // Neither result may leak the thrown text or submitted values.
    for (const values of [failed, rejected]) {
      assert.ok(!JSON.stringify(values).includes("provider exploded"));
      assert.ok(!JSON.stringify(values).includes(PRIVATE_EMAIL));
    }
  });

  it("keeps a committed submission when storing the result fails", async () => {
    const row = storedRow();

    const notStored = await persistNormalization(
      row.id,
      await normalizeSubmission(row),
      async () => {
        throw new Error("database unavailable");
      },
    );
    assert.equal(notStored, false);

    const attempt = await normalizeAndStore(row, async () => {
      throw new Error("database unavailable");
    });
    assert.equal(attempt.stored, false);
    // The values are still returned so the caller can log a safe status, but
    // nothing was written and no error escaped to the request handler.
    assert.equal(attempt.values.normalizationStatus, "normalized");

    const stored = await normalizeAndStore(row, async (id, values) => {
      assert.equal(id, row.id);
      assert.equal(values.normalizationStatus, "normalized");
    });
    assert.equal(stored.stored, true);
  });

  it("reads rows created before normalization existed", () => {
    assert.deepEqual(readStoredNormalization({}), {
      status: "not_run",
      version: null,
      referenceTime: null,
      errorCode: null,
      draft: null,
    });

    // An older row that predates the columns entirely.
    assert.deepEqual(
      readStoredNormalization({
        normalizationStatus: null,
        normalizerVersion: null,
        normalizationReferenceTime: null,
        normalizationErrorCode: null,
        normalizedDraft: null,
      }),
      {
        status: "not_run",
        version: null,
        referenceTime: null,
        errorCode: null,
        draft: null,
      },
    );
  });

  it("re-validates the stored draft before exposing it", async () => {
    const values = await normalizeSubmission(storedRow());
    const stored = {
      normalizationStatus: values.normalizationStatus,
      normalizerVersion: values.normalizerVersion,
      normalizationReferenceTime: values.normalizationReferenceTime,
      normalizationErrorCode: values.normalizationErrorCode,
      normalizedDraft: values.normalizedDraft,
    };

    const view = readStoredNormalization(stored);
    assert.equal(view.status, "normalized");
    assert.equal(view.version, "rules-v1");
    assert.equal(view.referenceTime, CREATED_AT.toISOString());
    assert.equal(view.errorCode, null);
    assert.deepEqual(view.draft?.title, "Community Pancake Breakfast");

    // A stored draft that no longer satisfies the contract is never returned.
    for (const broken of [
      { title: 42 },
      { ...values.normalizedDraft, extra: "not allowed" },
      { ...values.normalizedDraft, followUpEmail: PRIVATE_EMAIL },
      null,
    ]) {
      const failed = readStoredNormalization({ ...stored, normalizedDraft: broken });
      assert.equal(failed.status, "failed");
      assert.equal(failed.errorCode, "invalid_provider_output");
      assert.equal(failed.draft, null);
    }

    // Status is made consistent with the stored draft, not trusted blindly.
    const withFlag = readStoredNormalization({
      ...stored,
      normalizedDraft: {
        ...values.normalizedDraft,
        reviewFlags: [
          { code: "cost_unclear", message: "No admission cost was stated; do not assume the event is free." },
        ],
      },
    });
    assert.equal(withFlag.status, "needs_review");
    assert.equal(withFlag.draft?.reviewFlags.length, 1);

    // An unknown stored status is treated as "never ran", never as success.
    const unknown = readStoredNormalization({ ...stored, normalizationStatus: "succeeded" });
    assert.equal(unknown.status, "not_run");
    assert.equal(unknown.draft, null);
  });

  it("stays inside the documented status and error vocabulary", async () => {
    const values = await normalizeSubmission(storedRow());
    assert.ok(STORED_NORMALIZATION_STATUSES.includes(values.normalizationStatus));
    if (values.normalizationErrorCode !== null) {
      assert.ok(NORMALIZATION_ERROR_CODES.includes(values.normalizationErrorCode));
    }

    const failed = await normalizeSubmission(storedRow({ createdAt: new Date(Number.NaN) }));
    assert.equal(failed.normalizationStatus, "failed");
    assert.equal(failed.normalizationErrorCode, "invalid_input");
    assert.equal(failed.normalizationReferenceTime, null);
    assert.equal(failed.normalizedDraft, null);
  });
});
