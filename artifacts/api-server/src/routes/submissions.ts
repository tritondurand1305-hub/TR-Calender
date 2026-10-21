import { createHash, randomBytes } from "node:crypto";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  eventsTable,
  submissionAttachmentsTable,
  submissionsTable,
  uploadsTable,
} from "@workspace/db";
import {
  ApproveSubmissionBody,
  ApproveSubmissionParams,
  ApproveSubmissionResponse,
  CreateSubmissionBody,
  CreateSubmissionResponse,
  GetPrivateSubmissionAttachmentParams,
  ListSubmissionsResponse,
  UpdateSubmissionStatusBody,
  UpdateSubmissionStatusParams,
  UpdateSubmissionStatusResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/adminAuth";
import { EVENT_INTERVAL_ERROR, endsBeforeStart } from "../lib/eventInterval";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { rateLimit } from "../lib/rateLimit";
import { slugFor } from "../lib/slug";
import { normalizeAndStore, readStoredNormalization } from "../lib/submissionNormalization";
import {
  detectUploadContentType,
  MAX_UPLOAD_BYTES,
} from "../lib/uploadValidation";
import { eventResponse } from "./events";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();
const submissionLimit = rateLimit({
  name: "submission",
  limit: 5,
  windowMs: 60 * 60 * 1000,
});

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function submissionResponse(
  row: typeof submissionsTable.$inferSelect,
  attachments: (typeof submissionAttachmentsTable.$inferSelect)[],
) {
  // Explicit mapping, not `...row`: the normalization columns are stored
  // separately and must only reach an administrator through the validated
  // `normalization` shape below.
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    category: row.category,
    startAt: row.startAt?.toISOString() ?? null,
    endAt: row.endAt?.toISOString() ?? null,
    allDay: row.allDay,
    location: row.location,
    details: row.details,
    sourceUrl: row.sourceUrl,
    organizer: row.organizer,
    followUpEmail: row.followUpEmail,
    status: row.status,
    duplicatePotential: row.duplicatePotential,
    createdAt: row.createdAt.toISOString(),
    attachmentCount: attachments.length,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.originalName,
      contentType: attachment.contentType,
      size: attachment.size,
    })),
    // Re-validated on read; never a raw copy of the stored JSON.
    normalization: readStoredNormalization(row),
  };
}

/**
 * Normalize a submission that has already been committed and store the result.
 *
 * This is the exact step that runs after the insert transaction commits. It
 * never throws and returns nothing, so a normalizer or storage problem cannot
 * change the submitter's receipt. Exported so the route test can exercise it
 * without an HTTP request.
 */
export async function runPostCommitNormalization(
  submission: typeof submissionsTable.$inferSelect,
  log: { error: (context: Record<string, unknown>, message: string) => void },
): Promise<void> {
  try {
    const normalization = await normalizeAndStore(submission, async (id, values) => {
      await db.update(submissionsTable).set(values).where(eq(submissionsTable.id, id));
    });
    if (!normalization.stored) {
      // No error object: a driver error can echo parameter values. The row
      // keeps `not_run`, which the admin review screen surfaces.
      log.error(
        {
          submissionId: submission.id,
          normalizationStatus: normalization.values.normalizationStatus,
        },
        "Unable to store normalization result",
      );
    }
  } catch {
    // `normalizeAndStore` does not throw; this guard is the final barrier
    // between a normalization problem and a misleading 500.
    log.error({ submissionId: submission.id }, "Normalization step failed");
  }
}

function maybeDuplicate(
  title: string | null | undefined,
  startAt: Date | null,
  sourceUrl: string | null | undefined,
): Promise<boolean> {
  if (!title && !sourceUrl) {
    return Promise.resolve(false);
  }
  const normalizedTitle = title?.trim().toLocaleLowerCase("en-CA");
  const predicates: SQL[] = [];
  if (normalizedTitle) {
    const expression = startAt
      ? and(
          sql`lower(${eventsTable.title}) = ${normalizedTitle}`,
          eq(eventsTable.startAt, startAt),
          inArray(eventsTable.status, ["published", "cancelled"]),
        )
      : and(
          sql`lower(${eventsTable.title}) = ${normalizedTitle}`,
          inArray(eventsTable.status, ["published", "cancelled"]),
        );
    if (expression) predicates.push(expression);
  }
  if (sourceUrl) {
    const expression = and(
      eq(eventsTable.sourceUrl, sourceUrl),
      inArray(eventsTable.status, ["published", "cancelled"]),
    );
    if (expression) predicates.push(expression);
  }
  if (predicates.length === 0) return Promise.resolve(false);
  return db
    .select({ id: eventsTable.id })
    .from(eventsTable)
    .where(or(...predicates))
    .limit(1)
    .then((matches) => matches.length > 0);
}

router.post("/submissions", submissionLimit, async (req, res): Promise<void> => {
  const parsed = CreateSubmissionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please check the event details and try again" });
    return;
  }
  const data = parsed.data;
  if (data.website?.trim()) {
    res.status(201).json(
      CreateSubmissionResponse.parse({
        reference: `TRC-${randomBytes(3).toString("hex").toUpperCase()}`,
        status: "pending",
        duplicatePotential: false,
        message: "Your suggestion has been received for review.",
      }),
    );
    return;
  }

  const title = data.title?.trim() || null;
  const details = data.details?.trim() || null;
  const sourceUrl = data.sourceUrl?.trim() || null;
  const claims = data.attachmentClaims ?? [];
  if (claims.length > 3) {
    res.status(400).json({ error: "Please attach no more than three files" });
    return;
  }
  if (!title && !details && !sourceUrl && claims.length === 0) {
    res.status(400).json({
      error: "Add an event title, details, a source link, or a flyer before submitting",
    });
    return;
  }
  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Unsupported URL protocol");
      }
    } catch {
      res.status(400).json({ error: "Please enter a valid http or https source link" });
      return;
    }
  }

  const startAt = data.startAt ? new Date(data.startAt) : null;
  const endAt = data.endAt ? new Date(data.endAt) : null;
  if (startAt && endsBeforeStart(startAt, endAt)) {
    res.status(400).json({ error: EVENT_INTERVAL_ERROR });
    return;
  }

  const duplicatePotential = await maybeDuplicate(title, startAt, sourceUrl);
  const reference = `TRC-${randomBytes(4).toString("hex").toUpperCase()}`;

  try {
    const submission = await db.transaction(async (tx) => {
      const now = new Date();
      const [created] = await tx
        .insert(submissionsTable)
        .values({
          reference,
          title,
          category: data.category ?? null,
          startAt,
          endAt,
          allDay: data.allDay ?? false,
          location: data.location?.trim() || null,
          details,
          sourceUrl,
          organizer: data.organizer?.trim() || null,
          followUpEmail: data.followUpEmail?.trim().toLocaleLowerCase("en-CA") || null,
          duplicatePotential,
          status: "pending",
        })
        .returning();

      for (const claim of claims) {
        const [upload] = await tx
          .select()
          .from(uploadsTable)
          .where(
            and(
              eq(uploadsTable.id, claim.uploadId),
              eq(uploadsTable.tokenHash, tokenHash(claim.claimToken)),
              eq(uploadsTable.status, "ready"),
              isNull(uploadsTable.submissionId),
              gte(uploadsTable.expiresAt, now),
            ),
          )
          .limit(1);
        if (!upload) {
          throw new Error("UPLOAD_CLAIM_INVALID");
        }

        const [claimed] = await tx
          .update(uploadsTable)
          .set({
            status: "claimed",
            claimedAt: now,
            submissionId: created.id,
          })
          .where(
            and(
              eq(uploadsTable.id, upload.id),
              eq(uploadsTable.status, "ready"),
              isNull(uploadsTable.submissionId),
            ),
          )
          .returning();
        if (!claimed) {
          throw new Error("UPLOAD_CLAIM_INVALID");
        }
        await tx.insert(submissionAttachmentsTable).values({
          submissionId: created.id,
          uploadId: upload.id,
          originalName: upload.originalName,
          contentType: upload.contentType,
          size: upload.size,
        });
      }
      return created;
    });

    // The submission is committed. Normalization runs afterwards and is
    // deliberately isolated: it may fail, or its result may fail to store,
    // without changing the receipt the submitter receives.
    await runPostCommitNormalization(submission, req.log);

    res.status(201).json(
      CreateSubmissionResponse.parse({
        reference: submission.reference,
        status: "pending",
        duplicatePotential,
        message:
          "Your suggestion is waiting for a person to review it. It will not appear on the public calendar until approved.",
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "UPLOAD_CLAIM_INVALID") {
      res.status(400).json({
        error: "A flyer upload is invalid or expired. Please upload it again.",
      });
      return;
    }
    req.log.error({ err: error }, "Unable to store community submission");
    res.status(500).json({ error: "We could not save your submission. Please try again." });
  }
});

router.get("/admin/submissions", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(submissionsTable)
    .orderBy(asc(submissionsTable.createdAt));
  const ids = rows.map((row) => row.id);
  const attachments =
    ids.length > 0
      ? await db
          .select()
          .from(submissionAttachmentsTable)
          .where(inArray(submissionAttachmentsTable.submissionId, ids))
      : [];
  const bySubmission = new Map<string, typeof attachments>();
  for (const attachment of attachments) {
    const current = bySubmission.get(attachment.submissionId) ?? [];
    current.push(attachment);
    bySubmission.set(attachment.submissionId, current);
  }
  res.json(
    ListSubmissionsResponse.parse(
      rows.map((row) => submissionResponse(row, bySubmission.get(row.id) ?? [])),
    ),
  );
});

router.post(
  "/admin/submissions/:id/approve",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = ApproveSubmissionParams.safeParse(req.params);
    const parsed = ApproveSubmissionBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Please provide complete event details to approve" });
      return;
    }

    // Approval is the only path that can publish an event. Re-check the
    // interval here, server-side: the browser form is not a security boundary.
    // An invalid interval is rejected before the transaction starts, so no
    // event is inserted and the submission keeps its status.
    if (endsBeforeStart(parsed.data.startAt, parsed.data.endAt ?? null)) {
      res.status(400).json({ error: EVENT_INTERVAL_ERROR });
      return;
    }

    try {
      const created = await db.transaction(async (tx) => {
        const [submission] = await tx
          .select()
          .from(submissionsTable)
          .where(eq(submissionsTable.id, params.data.id))
          .limit(1);
        if (!submission) {
          throw new Error("SUBMISSION_NOT_FOUND");
        }
        if (submission.status !== "pending") {
          throw new Error("SUBMISSION_NOT_PENDING");
        }

        const data = parsed.data;
        const [event] = await tx
          .insert(eventsTable)
          .values({
            ...data,
            slug: slugFor(data.title),
            startAt: new Date(data.startAt),
            endAt: data.endAt ? new Date(data.endAt) : null,
            lastVerifiedAt: data.lastVerifiedAt ? new Date(data.lastVerifiedAt) : null,
            sourceUrl: data.sourceUrl ?? submission.sourceUrl,
            status: "published",
            isDemo: false,
            tags: data.tags ?? [],
          })
          .returning();
        await tx
          .update(submissionsTable)
          .set({ status: "approved", updatedAt: new Date() })
          .where(eq(submissionsTable.id, submission.id));
        return event;
      });
      res.status(201).json(ApproveSubmissionResponse.parse(eventResponse(created)));
    } catch (error) {
      if (error instanceof Error && error.message === "SUBMISSION_NOT_FOUND") {
        res.status(404).json({ error: "Submission not found" });
        return;
      }
      if (error instanceof Error && error.message === "SUBMISSION_NOT_PENDING") {
        res.status(400).json({ error: "This submission has already been reviewed" });
        return;
      }
      req.log.error({ err: error }, "Unable to approve community submission");
      res.status(500).json({ error: "The submission could not be approved" });
    }
  },
);

router.patch(
  "/admin/submissions/:id",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = UpdateSubmissionStatusParams.safeParse(req.params);
    const parsed = UpdateSubmissionStatusBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid submission status" });
      return;
    }

    const [updated] = await db
      .update(submissionsTable)
      .set({ status: parsed.data.status, updatedAt: new Date() })
      .where(eq(submissionsTable.id, params.data.id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    const attachments = await db
      .select()
      .from(submissionAttachmentsTable)
      .where(eq(submissionAttachmentsTable.submissionId, updated.id));
    res.json(
      UpdateSubmissionStatusResponse.parse(
        submissionResponse(updated, attachments),
      ),
    );
  },
);

router.get(
  "/admin/submissions/:id/attachments/:attachmentId",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = GetPrivateSubmissionAttachmentParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    const [result] = await db
      .select({
        attachment: submissionAttachmentsTable,
        upload: uploadsTable,
      })
      .from(submissionAttachmentsTable)
      .innerJoin(
        uploadsTable,
        eq(submissionAttachmentsTable.uploadId, uploadsTable.id),
      )
      .where(
        and(
          eq(submissionAttachmentsTable.id, params.data.attachmentId),
          eq(submissionAttachmentsTable.submissionId, params.data.id),
          eq(uploadsTable.status, "claimed"),
        ),
      )
      .limit(1);
    if (!result) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    try {
      const file = await objectStorage.getObjectEntityFile(result.upload.objectPath);
      const [metadata] = await file.getMetadata();
      const actualSize = Number(metadata.size);
      if (
        !Number.isSafeInteger(actualSize) ||
        actualSize < 1 ||
        actualSize > MAX_UPLOAD_BYTES ||
        actualSize !== result.attachment.size
      ) {
        await file.delete({ ignoreNotFound: true });
        res.status(404).json({ error: "Attachment failed private-file validation" });
        return;
      }
      const [contents] = await file.download();
      if (
        contents.length !== actualSize ||
        detectUploadContentType(contents) !== result.attachment.contentType
      ) {
        await file.delete({ ignoreNotFound: true });
        res.status(404).json({ error: "Attachment failed private-file validation" });
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "sandbox");
      res.setHeader("Content-Type", result.attachment.contentType);
      const safeName = result.attachment.originalName.replace(/["\\\r\n]/g, "_");
      const disposition =
        result.attachment.contentType === "application/pdf" ? "attachment" : "inline";
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="${safeName}"`,
      );
      res.send(contents);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Attachment not found" });
        return;
      }
      req.log.error({ err: error }, "Unable to serve private submission attachment");
      res.status(500).json({ error: "Attachment could not be opened" });
    }
  },
);

export default router;
