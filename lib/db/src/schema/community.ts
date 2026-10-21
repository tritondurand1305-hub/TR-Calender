import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const eventsTable = pgTable(
  "community_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    description: text("description"),
    category: text("category").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }),
    allDay: boolean("all_day").notNull().default(false),
    location: text("location"),
    sourceUrl: text("source_url"),
    organizer: text("organizer"),
    contact: text("contact"),
    cost: text("cost"),
    registrationUrl: text("registration_url"),
    tags: text("tags").array().notNull().default([]),
    status: text("status").notNull().default("draft"),
    isDemo: boolean("is_demo").notNull().default(false),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    // Import provenance. Null for events created by an administrator or
    // approved from a submission. Set only by the ingestion pipeline, which
    // uses (sourceKey, externalId) as the deduplication key and
    // sourceContentHash to tell an unchanged listing from a changed one.
    sourceKey: text("source_key"),
    externalId: text("external_id"),
    sourceName: text("source_name"),
    sourceContentHash: text("source_content_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("community_events_slug_idx").on(table.slug),
    // PostgreSQL treats NULLs as distinct, so events without provenance
    // (manual events) never collide here.
    uniqueIndex("community_events_source_ref_idx").on(
      table.sourceKey,
      table.externalId,
    ),
  ],
);

export const insertEventSchema = createInsertSchema(eventsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEvent = z.infer<typeof insertEventSchema>;
export type Event = typeof eventsTable.$inferSelect;

export const submissionsTable = pgTable(
  "community_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reference: text("reference").notNull(),
    title: text("title"),
    category: text("category"),
    startAt: timestamp("start_at", { withTimezone: true }),
    endAt: timestamp("end_at", { withTimezone: true }),
    allDay: boolean("all_day").notNull().default(false),
    location: text("location"),
    details: text("details"),
    sourceUrl: text("source_url"),
    organizer: text("organizer"),
    followUpEmail: text("follow_up_email"),
    status: text("status").notNull().default("pending"),
    duplicatePotential: boolean("duplicate_potential").notNull().default(false),
    // Normalisation result. Always additive to the raw submission above: these
    // columns are written by the server after the submission commits and never
    // replace a raw column. All of them are safe to read as null/default on
    // rows created before normalisation existed.
    normalizedDraft: jsonb("normalized_draft").$type<unknown>(),
    normalizationStatus: text("normalization_status").notNull().default("not_run"),
    normalizerVersion: text("normalizer_version"),
    normalizationReferenceTime: timestamp("normalization_reference_time", {
      withTimezone: true,
    }),
    normalizationErrorCode: text("normalization_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("community_submissions_reference_idx").on(table.reference)],
);

export const insertSubmissionSchema = createInsertSchema(submissionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSubmission = z.infer<typeof insertSubmissionSchema>;
export type Submission = typeof submissionsTable.$inferSelect;

export const uploadsTable = pgTable(
  "community_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    objectPath: text("object_path").notNull(),
    tokenHash: text("token_hash").notNull(),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    status: text("status").notNull().default("reserved"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    submissionId: uuid("submission_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("community_uploads_token_hash_idx").on(table.tokenHash),
    uniqueIndex("community_uploads_object_path_idx").on(table.objectPath),
  ],
);

export const insertUploadSchema = createInsertSchema(uploadsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUpload = z.infer<typeof insertUploadSchema>;
export type Upload = typeof uploadsTable.$inferSelect;

export const submissionAttachmentsTable = pgTable(
  "community_submission_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissionsTable.id, { onDelete: "cascade" }),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => uploadsTable.id, { onDelete: "restrict" }),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("community_submission_attachments_upload_idx").on(
      table.uploadId,
    ),
  ],
);

export const insertSubmissionAttachmentSchema = createInsertSchema(
  submissionAttachmentsTable,
).omit({
  id: true,
  createdAt: true,
});
export type InsertSubmissionAttachment = z.infer<
  typeof insertSubmissionAttachmentSchema
>;
export type SubmissionAttachment =
  typeof submissionAttachmentsTable.$inferSelect;

export const subscriptionsTable = pgTable(
  "community_email_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    weeklyDigest: boolean("weekly_digest").notNull().default(true),
    sportsRecreation: boolean("sports_recreation").notNull().default(false),
    familyYouth: boolean("family_youth").notNull().default(false),
    status: text("status").notNull().default("pending"),
    confirmationTokenHash: text("confirmation_token_hash"),
    confirmationExpiresAt: timestamp("confirmation_expires_at", {
      withTimezone: true,
    }),
    managementTokenHash: text("management_token_hash"),
    consentAt: timestamp("consent_at", { withTimezone: true }).notNull(),
    consentTextVersion: text("consent_text_version").notNull(),
    consentSource: text("consent_source").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    lastEmailSentAt: timestamp("last_email_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("community_email_subscriptions_email_idx").on(table.email),
    uniqueIndex("community_email_subscriptions_confirmation_token_idx").on(
      table.confirmationTokenHash,
    ),
    uniqueIndex("community_email_subscriptions_management_token_idx").on(
      table.managementTokenHash,
    ),
  ],
);

export const insertSubscriptionSchema = createInsertSchema(
  subscriptionsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptionsTable.$inferSelect;

export const emailDeliveriesTable = pgTable(
  "community_email_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptionsTable.id, { onDelete: "cascade" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    status: text("status").notNull().default("pending"),
    providerMessageId: text("provider_message_id"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("community_email_delivery_dedupe_idx").on(
      table.subscriptionId,
      table.periodStart,
    ),
  ],
);

export const insertEmailDeliverySchema = createInsertSchema(
  emailDeliveriesTable,
).omit({
  id: true,
  createdAt: true,
});
export type InsertEmailDelivery = z.infer<typeof insertEmailDeliverySchema>;
export type EmailDelivery = typeof emailDeliveriesTable.$inferSelect;

/**
 * Health of one ingestion source, updated once per run.
 *
 * A failed run writes status/lastFailureAt/lastErrorCode here and nothing
 * else: imported events keep their previous content and lastVerifiedAt, so a
 * broken source is visible without old data pretending to be fresh.
 */
export const ingestionSourcesTable = pgTable(
  "community_ingestion_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceKey: text("source_key").notNull(),
    sourceUrl: text("source_url").notNull(),
    // idle | ok | partial | failed
    status: text("status").notNull().default("idle"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastRunSummary: jsonb("last_run_summary").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("community_ingestion_sources_key_idx").on(table.sourceKey),
  ],
);

export const insertIngestionSourceSchema = createInsertSchema(
  ingestionSourcesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertIngestionSource = z.infer<typeof insertIngestionSourceSchema>;
export type IngestionSource = typeof ingestionSourcesTable.$inferSelect;

/**
 * One row per listing seen in a source, whatever happened to it. This is where
 * a listing is "held for review": when required fields cannot be read, the
 * parsed payload is stored here with outcome `held` and a reason code, and no
 * event is written.
 */
export const ingestionItemsTable = pgTable(
  "community_ingestion_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceKey: text("source_key").notNull(),
    externalId: text("external_id").notNull(),
    // imported | updated | unchanged | held | skipped
    outcome: text("outcome").notNull(),
    reasonCode: text("reason_code"),
    sourceUrl: text("source_url"),
    payload: jsonb("payload").$type<unknown>(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("community_ingestion_items_ref_idx").on(
      table.sourceKey,
      table.externalId,
    ),
  ],
);

export const insertIngestionItemSchema = createInsertSchema(
  ingestionItemsTable,
).omit({ id: true, firstSeenAt: true, lastSeenAt: true, updatedAt: true });
export type InsertIngestionItem = z.infer<typeof insertIngestionItemSchema>;
export type IngestionItem = typeof ingestionItemsTable.$inferSelect;
