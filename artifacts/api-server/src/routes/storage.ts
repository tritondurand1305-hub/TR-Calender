import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CompleteUploadBody,
  CompleteUploadResponse,
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { db, uploadsTable } from "@workspace/db";
import { ObjectStorageService } from "../lib/objectStorage";
import { rateLimit } from "../lib/rateLimit";

const router: IRouter = Router();
const storage = new ObjectStorageService();
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const acceptedContentTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const uploadLimit = rateLimit({
  name: "anonymous-upload",
  limit: 10,
  windowMs: 60 * 60 * 1000,
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeOriginalName(name: string): string {
  const normalized = name
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
    .trim()
    .slice(0, 180);
  return normalized || "community-flyer";
}

function detectContentType(bytes: Buffer): string | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 5 && bytes.toString("ascii", 0, 5) === "%PDF-") {
    return "application/pdf";
  }
  return null;
}

async function removeExpiredUploads(): Promise<void> {
  const expired = await db
    .select()
    .from(uploadsTable)
    .where(
      and(
        lt(uploadsTable.expiresAt, new Date()),
        inArray(uploadsTable.status, ["reserved", "ready"]),
        isNull(uploadsTable.submissionId),
      ),
    )
    .limit(20);

  for (const upload of expired) {
    try {
      const file = await storage.getObjectEntityFile(upload.objectPath);
      await file.delete({ ignoreNotFound: true });
    } catch {
      // Expired metadata is still removed; an already-missing object is harmless.
    }
    await db.delete(uploadsTable).where(eq(uploadsTable.id, upload.id));
  }
}

router.post(
  "/storage/uploads/request-url",
  uploadLimit,
  async (req, res): Promise<void> => {
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Choose a JPG, PNG, WebP or PDF up to 8 MB" });
      return;
    }
    if (parsed.data.website?.trim()) {
      res.status(400).json({ error: "Upload request rejected" });
      return;
    }
    if (
      !acceptedContentTypes.has(parsed.data.contentType) ||
      parsed.data.size > MAX_UPLOAD_BYTES
    ) {
      res.status(400).json({ error: "Choose a supported file up to 8 MB" });
      return;
    }
    if (!process.env.PRIVATE_OBJECT_DIR) {
      res.status(503).json({
        error: "Private file storage is not configured. Please submit details or a source link instead.",
      });
      return;
    }

    try {
      await removeExpiredUploads();
      const uploadURL = await storage.getObjectEntityUploadURL();
      const objectPath = storage.normalizeObjectEntityPath(uploadURL);
      const claimToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const [upload] = await db
        .insert(uploadsTable)
        .values({
          objectPath,
          tokenHash: hashToken(claimToken),
          originalName: safeOriginalName(parsed.data.name),
          contentType: parsed.data.contentType,
          size: parsed.data.size,
          status: "reserved",
          expiresAt,
        })
        .returning({ id: uploadsTable.id });

      res.json(
        RequestUploadUrlResponse.parse({
          uploadId: upload.id,
          claimToken,
          uploadURL,
          objectPath,
          expiresAt: expiresAt.toISOString(),
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "Unable to create private upload reservation");
      res.status(503).json({ error: "Private file storage is temporarily unavailable" });
    }
  },
);

router.post(
  "/storage/uploads/complete",
  uploadLimit,
  async (req, res): Promise<void> => {
    const parsed = CompleteUploadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid upload confirmation" });
      return;
    }

    const [upload] = await db
      .select()
      .from(uploadsTable)
      .where(
        and(
          eq(uploadsTable.id, parsed.data.uploadId),
          eq(uploadsTable.tokenHash, hashToken(parsed.data.claimToken)),
          eq(uploadsTable.status, "reserved"),
          isNull(uploadsTable.submissionId),
        ),
      )
      .limit(1);
    if (!upload || upload.expiresAt <= new Date()) {
      res.status(400).json({ error: "This upload link has expired. Please upload the file again." });
      return;
    }

    try {
      const file = await storage.getObjectEntityFile(upload.objectPath);
      const [metadata] = await file.getMetadata();
      const actualSize = Number(metadata.size);
      if (
        !Number.isSafeInteger(actualSize) ||
        actualSize < 1 ||
        actualSize > MAX_UPLOAD_BYTES ||
        actualSize !== upload.size
      ) {
        await file.delete({ ignoreNotFound: true });
        await db
          .update(uploadsTable)
          .set({ status: "rejected" })
          .where(eq(uploadsTable.id, upload.id));
        res.status(400).json({ error: "The uploaded file size did not match. Please try again." });
        return;
      }

      const [contents] = await file.download();
      const detected = detectContentType(contents);
      if (!detected || detected !== upload.contentType) {
        await file.delete({ ignoreNotFound: true });
        await db
          .update(uploadsTable)
          .set({ status: "rejected" })
          .where(eq(uploadsTable.id, upload.id));
        res.status(400).json({
          error: "The file contents do not match a supported image or PDF. Please choose another file.",
        });
        return;
      }

      const [updated] = await db
        .update(uploadsTable)
        .set({
          contentType: detected,
          size: actualSize,
          status: "ready",
          completedAt: new Date(),
        })
        .where(
          and(
            eq(uploadsTable.id, upload.id),
            eq(uploadsTable.status, "reserved"),
            isNull(uploadsTable.submissionId),
          ),
        )
        .returning();
      if (!updated) {
        res.status(400).json({ error: "This upload has already been used" });
        return;
      }
      res.json(
        CompleteUploadResponse.parse({
          uploadId: updated.id,
          name: updated.originalName,
          size: updated.size,
          contentType: detected,
          claimToken: parsed.data.claimToken,
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "Unable to validate private upload");
      res.status(400).json({ error: "The uploaded file could not be validated. Please try again." });
    }
  },
);

export default router;
