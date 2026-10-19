import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  ConfirmSubscriptionBody,
  ConfirmSubscriptionResponse,
  CreateSubscriptionBody,
  CreateSubscriptionResponse,
  GetEmailDeliveryStatusResponse,
  GetSubscriptionPreferencesBody,
  GetSubscriptionPreferencesResponse,
  GetWeeklyDigestPreviewQueryParams,
  GetWeeklyDigestPreviewResponse,
  UnsubscribeBody,
  UnsubscribeResponse,
  UpdateSubscriptionPreferencesBody,
  UpdateSubscriptionPreferencesResponse,
} from "@workspace/api-zod";
import {
  db,
  eventsTable,
  subscriptionsTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/adminAuth";
import { getEmailDeliveryStatus, sendEmail } from "../lib/emailDelivery";
import { rateLimit } from "../lib/rateLimit";
import { eventResponse } from "./events";

const router: IRouter = Router();
const subscriptionRateLimit = rateLimit({
  name: "email-subscription",
  limit: 5,
  windowMs: 60 * 60 * 1000,
});
const tokenRateLimit = rateLimit({
  name: "email-token-action",
  limit: 20,
  windowMs: 60 * 60 * 1000,
});
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

function publicAppUrl(): string | null {
  const explicit = process.env.PUBLIC_APP_URL?.trim();
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  const candidate = explicit || (domain ? `https://${domain}` : "");
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function vancouverDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function selectedForDigest(
  event: { category: string },
  preferences: {
    weeklyDigest: boolean;
    sportsRecreation: boolean;
    familyYouth: boolean;
  },
): boolean {
  if (!preferences.weeklyDigest) return false;
  if (event.category === "Sports & Recreation") {
    return preferences.sportsRecreation;
  }
  if (event.category === "Families & Youth") {
    return preferences.familyYouth;
  }
  return true;
}

router.post(
  "/subscriptions",
  subscriptionRateLimit,
  async (req, res): Promise<void> => {
    const parsed = CreateSubscriptionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        accepted: false,
        deliveryConfigured: getEmailDeliveryStatus().configured,
        message: "Please enter a valid email address and confirm your consent.",
      });
      return;
    }

    const delivery = getEmailDeliveryStatus();
    const baseUrl = publicAppUrl();
    if (!delivery.configured || !delivery.automaticSendingEnabled || !baseUrl) {
      res.status(202).json(
        CreateSubscriptionResponse.parse({
          accepted: false,
          deliveryConfigured: delivery.configured,
          message: !baseUrl
            ? "Email confirmation is not configured for this deployment. Your address was not saved."
            : delivery.message,
        }),
      );
      return;
    }

    const email = parsed.data.email.trim().toLocaleLowerCase("en-CA");
    const [existing] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.email, email))
      .limit(1);
    if (existing?.status === "active") {
      res.status(202).json(
        CreateSubscriptionResponse.parse({
          accepted: true,
          deliveryConfigured: true,
          message:
            "If this address can receive calendar emails, it will receive a confirmation link.",
        }),
      );
      return;
    }

    const confirmationToken = randomBytes(32).toString("base64url");
    const managementToken = randomBytes(32).toString("base64url");
    const now = new Date();
    const values = {
      email,
      weeklyDigest: parsed.data.weeklyDigest,
      sportsRecreation: parsed.data.sportsRecreation,
      familyYouth: parsed.data.familyYouth,
      status: "pending",
      confirmationTokenHash: tokenHash(confirmationToken),
      confirmationExpiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
      managementTokenHash: tokenHash(managementToken),
      consentAt: now,
      consentTextVersion: "community-email-v1",
      consentSource: "public-calendar-form",
      confirmedAt: null,
      unsubscribedAt: null,
      updatedAt: now,
    };

    let subscriptionId: string;
    try {
      if (existing) {
        const [updated] = await db
          .update(subscriptionsTable)
          .set(values)
          .where(eq(subscriptionsTable.id, existing.id))
          .returning({ id: subscriptionsTable.id });
        subscriptionId = updated.id;
      } else {
        const [created] = await db
          .insert(subscriptionsTable)
          .values(values)
          .returning({ id: subscriptionsTable.id });
        subscriptionId = created.id;
      }
    } catch {
      req.log.warn("Email subscription could not be stored");
      res.status(202).json(
        CreateSubscriptionResponse.parse({
          accepted: false,
          deliveryConfigured: true,
          message: "We could not save the request. Please try again shortly.",
        }),
      );
      return;
    }

    const confirmUrl = `${baseUrl}/updates/confirm#${confirmationToken}`;
    const manageUrl = `${baseUrl}/updates/manage#${managementToken}`;
    const unsubscribeUrl = `${baseUrl}/updates/unsubscribe#${managementToken}`;
    try {
      await sendEmail({
        to: email,
        subject: "Confirm your Tumbler Ridge calendar emails",
        text: [
          "Please confirm that you want to receive emails from the Tumbler Ridge Community Calendar.",
          "",
          `Confirm: ${confirmUrl}`,
          `Manage preferences: ${manageUrl}`,
          `Unsubscribe: ${unsubscribeUrl}`,
          "",
          "If you did not request these emails, you can ignore this message.",
        ].join("\n"),
        html: `<p>Please confirm that you want to receive emails from the Tumbler Ridge Community Calendar.</p><p><a href="${confirmUrl}">Confirm subscription</a></p><p><a href="${manageUrl}">Manage preferences</a></p><p><a href="${unsubscribeUrl}">Unsubscribe</a></p><p>If you did not request these emails, you can ignore this message.</p>`,
      });
      await db
        .update(subscriptionsTable)
        .set({ lastEmailSentAt: new Date(), updatedAt: new Date() })
        .where(eq(subscriptionsTable.id, subscriptionId));
      res.status(202).json(
        CreateSubscriptionResponse.parse({
          accepted: true,
          deliveryConfigured: true,
          message:
            "Check your inbox for a confirmation link. Your subscription will not start until you confirm.",
        }),
      );
    } catch {
      req.log.warn("Email confirmation delivery failed");
      res.status(202).json(
        CreateSubscriptionResponse.parse({
          accepted: false,
          deliveryConfigured: true,
          message:
            "The confirmation email could not be sent. Your subscription is not active; please try again later.",
        }),
      );
    }
  },
);

router.post(
  "/subscriptions/confirm",
  tokenRateLimit,
  async (req, res): Promise<void> => {
    const parsed = ConfirmSubscriptionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: "This confirmation link is invalid or expired." });
      return;
    }
    const [subscription] = await db
      .update(subscriptionsTable)
      .set({
        status: "active",
        confirmationTokenHash: null,
        confirmationExpiresAt: null,
        confirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(subscriptionsTable.confirmationTokenHash, tokenHash(parsed.data.token)),
          eq(subscriptionsTable.status, "pending"),
          gte(subscriptionsTable.confirmationExpiresAt, new Date()),
        ),
      )
      .returning({ id: subscriptionsTable.id });

    res.json(
      ConfirmSubscriptionResponse.parse(
        subscription
          ? {
              success: true,
              message: "Your email preferences are confirmed.",
            }
          : {
              success: false,
              message: "This confirmation link is invalid, expired, or already used.",
            },
      ),
    );
  },
);

router.post(
  "/subscriptions/preferences",
  tokenRateLimit,
  async (req, res): Promise<void> => {
    const parsed = GetSubscriptionPreferencesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "This private management link is invalid" });
      return;
    }
    const [subscription] = await db
      .select()
      .from(subscriptionsTable)
      .where(
        eq(
          subscriptionsTable.managementTokenHash,
          tokenHash(parsed.data.token),
        ),
      )
      .limit(1);
    if (!subscription) {
      res.status(404).json({ error: "This private management link is invalid" });
      return;
    }
    res.json(
      GetSubscriptionPreferencesResponse.parse({
        weeklyDigest: subscription.weeklyDigest,
        sportsRecreation: subscription.sportsRecreation,
        familyYouth: subscription.familyYouth,
        confirmed: subscription.status === "active",
        unsubscribed: subscription.status === "unsubscribed",
      }),
    );
  },
);

router.patch(
  "/subscriptions/preferences",
  tokenRateLimit,
  async (req, res): Promise<void> => {
    const parsed = UpdateSubscriptionPreferencesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: "Invalid email preferences" });
      return;
    }
    const [updated] = await db
      .update(subscriptionsTable)
      .set({
        weeklyDigest: parsed.data.weeklyDigest,
        sportsRecreation: parsed.data.sportsRecreation,
        familyYouth: parsed.data.familyYouth,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(
            subscriptionsTable.managementTokenHash,
            tokenHash(parsed.data.token),
          ),
          eq(subscriptionsTable.status, "active"),
        ),
      )
      .returning({ id: subscriptionsTable.id });

    res.json(
      UpdateSubscriptionPreferencesResponse.parse(
        updated
          ? { success: true, message: "Your email preferences have been saved." }
          : {
              success: false,
              message: "The link is invalid or the subscription is not active.",
            },
      ),
    );
  },
);

router.post(
  "/subscriptions/unsubscribe",
  tokenRateLimit,
  async (req, res): Promise<void> => {
    const parsed = UnsubscribeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: "This private unsubscribe link is invalid" });
      return;
    }
    const [subscription] = await db
      .update(subscriptionsTable)
      .set({
        status: "unsubscribed",
        unsubscribedAt: new Date(),
        updatedAt: new Date(),
        confirmationTokenHash: null,
        confirmationExpiresAt: null,
      })
      .where(
        eq(
          subscriptionsTable.managementTokenHash,
          tokenHash(parsed.data.token),
        ),
      )
      .returning({ id: subscriptionsTable.id });
    res.json(
      UnsubscribeResponse.parse(
        subscription
          ? { success: true, message: "You have been unsubscribed." }
          : { success: false, message: "This private unsubscribe link is invalid." },
      ),
    );
  },
);

router.get(
  "/admin/email/status",
  requireAdmin,
  (_req, res): void => {
    res.json(GetEmailDeliveryStatusResponse.parse(getEmailDeliveryStatus()));
  },
);

router.get(
  "/admin/digest/preview",
  requireAdmin,
  async (req, res): Promise<void> => {
    const weekOf =
      typeof req.query.weekOf === "string" ? new Date(req.query.weekOf) : undefined;
    const parsed = GetWeeklyDigestPreviewQueryParams.safeParse({ weekOf });
    if (!parsed.success || (weekOf && Number.isNaN(weekOf.getTime()))) {
      res.status(400).json({ error: "Invalid digest week" });
      return;
    }

    const requested = parsed.data.weekOf ?? new Date(`${vancouverDate(new Date())}T12:00:00.000Z`);
    const monday = new Date(requested);
    monday.setUTCHours(12, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const nextMonday = addDays(monday, 7);
    const candidates = await db
      .select()
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.status, "published"),
          gte(eventsTable.startAt, new Date(`${vancouverDate(monday)}T00:00:00.000Z`)),
          lt(eventsTable.startAt, new Date(`${vancouverDate(nextMonday)}T08:00:00.000Z`)),
        ),
      )
      .orderBy(asc(eventsTable.startAt));

    const events = candidates.filter((event) => {
      const day = vancouverDate(event.startAt);
      return (
        day >= vancouverDate(monday) &&
        day < vancouverDate(nextMonday) &&
        selectedForDigest(event, {
          weeklyDigest: true,
          sportsRecreation: false,
          familyYouth: false,
        })
      );
    });
    res.json(
      GetWeeklyDigestPreviewResponse.parse({
        weekStart: vancouverDate(monday),
        weekEnd: vancouverDate(addDays(nextMonday, -1)),
        timezone: "America/Vancouver",
        events: events.map(eventResponse),
        deliveryConfigured: getEmailDeliveryStatus().configured,
      }),
    );
  },
);

export default router;
