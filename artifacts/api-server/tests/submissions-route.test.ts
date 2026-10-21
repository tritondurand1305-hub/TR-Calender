/**
 * Route-level tests for the submission endpoints.
 *
 * Run from `artifacts/api-server` with: node --test tests/*.test.ts
 *
 * The API server imports its modules without file extensions (esbuild resolves
 * them), so the route cannot be imported directly by Node's type stripping.
 * The test bundles the real route source with the package's existing esbuild
 * devDependency. Two things are then exercised without a database:
 *
 *  - the approval handler, called directly (skipping the Clerk middleware).
 *    Its invalid-interval branch returns before any database call;
 *  - the submission response serializer, whose output is parsed with the
 *    generated `ListSubmissionsResponse` contract.
 *
 * The interval guard itself is also unit-tested here.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The package barrel uses extensionless imports that Node's type stripping
// cannot resolve, so the generated schema module is imported directly. It has
// no relative imports of its own.
import { ListSubmissionsResponse } from "../../../lib/api-zod/src/generated/api.ts";
import { EVENT_INTERVAL_ERROR, endsBeforeStart } from "../src/lib/eventInterval.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "..", "..");
const bundleDirectory = path.join(packageRoot, "node_modules", ".route-test");
const bundlePath = path.join(bundleDirectory, "submissions-route.mjs");

interface HandlerResult {
  readonly statusCode: number;
  readonly body: unknown;
}

interface FakeRow {
  readonly [key: string]: unknown;
}

type ResponseSerializer = (row: FakeRow, attachments: ReadonlyArray<unknown>) => unknown;
type PostCommitNormalizer = (
  submission: FakeRow,
  log: { error: (context: Record<string, unknown>, message: string) => void },
) => Promise<void>;

let invokeApproval: (body: Record<string, unknown>) => Promise<HandlerResult>;
let serializeSubmission: ResponseSerializer;
let runPostCommitNormalization: PostCommitNormalizer;

before(async () => {
  const { build } = await import("esbuild");
  await mkdir(bundleDirectory, { recursive: true });
  await build({
    entryPoints: [path.join(packageRoot, "src", "routes", "submissions.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    // Packages that cannot be bundled into ESM stay external and resolve from
    // the api-server's own node_modules. Workspace packages are inlined so the
    // bundle contains the current source.
    external: [
      "express",
      "pg-native",
      "@google-cloud/storage",
      "@clerk/express",
      "@clerk/shared",
      "pino",
      "pino-http",
      "cookie-parser",
    ],
    alias: {
      "@workspace/db": path.join(repositoryRoot, "lib", "db", "src", "index.ts"),
      "@workspace/api-zod": path.join(repositoryRoot, "lib", "api-zod", "src", "index.ts"),
    },
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module";\nglobalThis.require = __createRequire(import.meta.url);',
    },
    outfile: bundlePath,
    logLevel: "silent",
  });

  // Never talk to a real database. The interval rejection happens before any
  // query, and this value makes an accidental connection fail fast.
  process.env.DATABASE_URL = "postgres://user:password@127.0.0.1:5432/normalizer-test";

  const module = (await import(bundlePath)) as {
    default: unknown;
    submissionResponse?: ResponseSerializer;
    runPostCommitNormalization?: PostCommitNormalizer;
  };
  const router = module.default as {
    stack: Array<{
      route?: { path: string; stack: Array<{ handle: (req: unknown, res: unknown) => unknown }> };
    }>;
  };
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/admin/submissions/:id/approve",
  );
  assert.ok(layer?.route, "approval route is not registered");
  // The route stack is [requireAdmin, handler]; call the handler directly so the
  // test does not need Clerk credentials.
  const handler = layer.route.stack[layer.route.stack.length - 1]?.handle;
  assert.equal(typeof handler, "function", "approval handler is not a function");

  const serializer = module.submissionResponse;
  assert.ok(serializer, "submission response serializer is not exported");
  serializeSubmission = serializer;

  const postCommit = module.runPostCommitNormalization;
  assert.ok(postCommit, "post-commit normalization step is not exported");
  runPostCommitNormalization = postCommit;

  invokeApproval = async (body) => {
    const result = { statusCode: 0, body: null as unknown };
    const res = {
      status(code: number) {
        result.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        result.body = payload;
        return this;
      },
    };
    const req = {
      params: { id: "11111111-1111-4111-8111-111111111111" },
      body,
      log: { error() {} },
    };
    await handler(req, res);
    return result;
  };
});

after(async () => {
  await rm(bundleDirectory, { recursive: true, force: true });
});

function approvalBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Fall Fair",
    category: "Community Events",
    startAt: "2026-11-07T19:00:00.000Z",
    endAt: "2026-11-07T17:00:00.000Z",
    allDay: false,
    ...overrides,
  };
}

describe("event interval guard", () => {
  it("treats only end-before-start as invalid", () => {
    const start = new Date("2026-11-07T17:00:00.000Z");

    assert.equal(endsBeforeStart(start, new Date("2026-11-07T19:00:00.000Z")), false);
    assert.equal(endsBeforeStart(start, new Date("2026-11-07T17:00:00.000Z")), false);
    assert.equal(endsBeforeStart(start, new Date("2026-11-07T16:59:59.999Z")), true);
    assert.equal(endsBeforeStart(start, null), false);
  });
});

describe("POST /admin/submissions/:id/approve", () => {
  it("rejects an end-before-start interval before publishing anything", async () => {
    const result = await invokeApproval(approvalBody());

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.body, { error: EVENT_INTERVAL_ERROR });
  });

  it("still rejects an incomplete body through the request contract", async () => {
    const result = await invokeApproval({ title: "x" });

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.body, { error: "Please provide complete event details to approve" });
  });
});

describe("POST /submissions post-commit normalization", () => {
  it("cannot throw when the result cannot be stored", async () => {
    // The database in this test is unreachable on purpose: the normalization
    // step must swallow the storage failure and log a safe message, so the
    // already-committed submission still returns its 201 receipt.
    const logged: string[] = [];
    await runPostCommitNormalization(storedSubmission() as never, {
      error: (_context, message) => logged.push(message),
    });

    assert.ok(
      logged.length <= 1 && logged.every((message) => message.includes("normalization result")),
      JSON.stringify(logged),
    );
  });
});

const PRIVATE_EMAIL = "private.organizer@example.org";

function storedSubmission(overrides: Record<string, unknown> = {}): FakeRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    reference: "TRC-12345678",
    title: "Community Pancake Breakfast",
    category: "Community Events",
    startAt: new Date("2026-11-07T17:00:00.000Z"),
    endAt: new Date("2026-11-07T19:00:00.000Z"),
    allDay: false,
    location: "Tumbler Ridge Community Centre",
    details: "Join us for pancakes. Admission is free.",
    sourceUrl: "https://example.org/events/pancakes",
    organizer: "Tumbler Ridge Lions Club",
    followUpEmail: PRIVATE_EMAIL,
    status: "pending",
    duplicatePotential: false,
    normalizedDraft: null,
    normalizationStatus: "not_run",
    normalizerVersion: null,
    normalizationReferenceTime: null,
    normalizationErrorCode: null,
    createdAt: new Date("2026-10-20T18:00:00.000Z"),
    updatedAt: new Date("2026-10-20T18:00:00.000Z"),
    ...overrides,
  };
}

const storedDraft = {
  title: "Community Pancake Breakfast",
  category: "Community Events",
  summary: "Join us for pancakes.",
  description: "Join us for pancakes. Admission is free.",
  startAt: "2026-11-07T17:00:00.000Z",
  endAt: "2026-11-07T19:00:00.000Z",
  allDay: false,
  location: "Tumbler Ridge Community Centre",
  organizer: "Tumbler Ridge Lions Club",
  contact: null,
  cost: "Free",
  registrationUrl: null,
  sourceUrl: "https://example.org/events/pancakes",
  tags: [],
  reviewFlags: [],
  changedFields: [],
  unresolvedQuestions: [],
};

function parseResponse(row: FakeRow) {
  const parsed = ListSubmissionsResponse.parse([serializeSubmission(row, [])]);
  const first = parsed[0];
  assert.ok(first);
  return first;
}

describe("GET /admin/submissions response contract", () => {
  it("exposes the validated normalization result and no raw columns", () => {
    const parsed = parseResponse(
      storedSubmission({
        normalizedDraft: storedDraft,
        normalizationStatus: "normalized",
        normalizerVersion: "rules-v1",
        normalizationReferenceTime: new Date("2026-10-20T18:00:00.000Z"),
      }) as never,
    );

    assert.equal(parsed.normalization.status, "normalized");
    assert.equal(parsed.normalization.version, "rules-v1");
    assert.equal(parsed.normalization.errorCode, null);
    assert.equal(
      (parsed.normalization.referenceTime as Date).toISOString(),
      "2026-10-20T18:00:00.000Z",
    );
    assert.equal(parsed.normalization.draft?.title, "Community Pancake Breakfast");
    assert.equal(parsed.normalization.draft?.cost, "Free");

    // The draft timestamp survives the round-trip as the same instant.
    const serialised = JSON.parse(JSON.stringify(parsed)) as {
      normalization: { draft: { startAt: string } };
      normalizedDraft?: unknown;
      normalizationStatus?: unknown;
    };
    assert.equal(serialised.normalization.draft.startAt, "2026-11-07T17:00:00.000Z");

    // Stored columns are mapped, never spread into the response.
    assert.equal("normalizedDraft" in parsed, false);
    assert.equal("normalizationStatus" in parsed, false);
    assert.equal("normalizerVersion" in parsed, false);
    assert.equal("updatedAt" in parsed, false);
  });

  it("keeps older rows readable as not_run", () => {
    const parsed = parseResponse(storedSubmission() as never);

    assert.deepEqual(parsed.normalization, {
      status: "not_run",
      version: null,
      referenceTime: null,
      errorCode: null,
      draft: null,
    });
  });

  it("never returns a corrupt stored draft", () => {
    const parsed = parseResponse(
      storedSubmission({
        normalizedDraft: { ...storedDraft, cost: { not: "a string" } },
        normalizationStatus: "needs_review",
        normalizerVersion: "rules-v1",
      }) as never,
    );

    assert.equal(parsed.normalization.status, "failed");
    assert.equal(parsed.normalization.errorCode, "invalid_provider_output");
    assert.equal(parsed.normalization.draft, null);
  });

  it("does not leak the follow-up email through the normalization payload", () => {
    const parsed = parseResponse(
      storedSubmission({
        normalizedDraft: storedDraft,
        normalizationStatus: "normalized",
        normalizerVersion: "rules-v1",
      }) as never,
    );

    assert.ok(!JSON.stringify(parsed.normalization).includes(PRIVATE_EMAIL));
  });
});
