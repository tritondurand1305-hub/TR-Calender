import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import {
  db,
  eventsTable,
} from "@workspace/db";
import {
  CreateEventBody,
  CreateEventResponse,
  DeleteEventParams,
  GetAdminStatusResponse,
  GetCalendarOverviewQueryParams,
  GetCalendarOverviewResponse,
  GetEventParams,
  GetEventResponse,
  ListAdminEventsResponse,
  ListEventsQueryParams,
  ListEventsResponse,
  UpdateEventBody,
  UpdateEventParams,
  UpdateEventResponse,
} from "@workspace/api-zod";
import { configuredAdminEmails, isAdministrator, requireAdmin } from "../middlewares/adminAuth";
import { getEmailDeliveryStatus } from "../lib/emailDelivery";

const router: IRouter = Router();
const VANCOUVER_TIMEZONE = "America/Vancouver";

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

export function eventResponse(event: typeof eventsTable.$inferSelect) {
  return {
    ...event,
    startAt: event.startAt.toISOString(),
    endAt: toIso(event.endAt),
    lastVerifiedAt: toIso(event.lastVerifiedAt),
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
    tags: event.tags ?? [],
  };
}

function vancouverDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: VANCOUVER_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function slugFor(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-CA")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${base || "event"}-${randomBytes(3).toString("hex")}`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

router.get("/events", async (req, res): Promise<void> => {
  const parsed = ListEventsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid event search filters" });
    return;
  }

  const { q, category, from, to, includeNotices } = parsed.data;
  const conditions = [
    inArray(eventsTable.status, ["published", "cancelled"]),
  ];

  if (category) {
    conditions.push(eq(eventsTable.category, category));
  }
  if (from) {
    conditions.push(gte(eventsTable.startAt, new Date(from)));
  } else {
    conditions.push(gte(eventsTable.startAt, new Date()));
  }
  if (to) {
    conditions.push(lt(eventsTable.startAt, new Date(to)));
  }
  if (!includeNotices) {
    conditions.push(ne(eventsTable.category, "Community Notices"));
  }

  if (q?.trim()) {
    const searchText = `%${escapeLike(q.trim())}%`;
    const dateSearch = /^\d{4}-\d{2}-\d{2}$/.test(q.trim())
      ? and(
          gte(eventsTable.startAt, new Date(`${q.trim()}T00:00:00.000Z`)),
          lt(eventsTable.startAt, new Date(`${q.trim()}T24:00:00.000Z`)),
        )
      : undefined;
    conditions.push(
      or(
        ilike(eventsTable.title, searchText),
        ilike(eventsTable.summary, searchText),
        ilike(eventsTable.description, searchText),
        ilike(eventsTable.location, searchText),
        ilike(eventsTable.organizer, searchText),
        sql`${eventsTable.tags}::text ilike ${searchText}`,
        sql`${eventsTable.startAt}::text ilike ${searchText}`,
        ...(dateSearch ? [dateSearch] : []),
      )!,
    );
  }

  const events = await db
    .select()
    .from(eventsTable)
    .where(and(...conditions))
    .orderBy(asc(eventsTable.startAt))
    .limit(250);

  res.json(ListEventsResponse.parse(events.map(eventResponse)));
});

router.get("/events/:slug", async (req, res): Promise<void> => {
  const params = GetEventParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid event link" });
    return;
  }

  const [event] = await db
    .select()
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.slug, params.data.slug),
        inArray(eventsTable.status, ["published", "cancelled"]),
      ),
    )
    .limit(1);

  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  res.json(GetEventResponse.parse(eventResponse(event)));
});

router.get("/calendar/overview", async (req, res): Promise<void> => {
  const parsed = GetCalendarOverviewQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid calendar week" });
    return;
  }

  const requested = parsed.data.weekOf ?? vancouverDate(new Date());
  const anchor = new Date(`${requested}T12:00:00.000Z`);
  const mondayOffset = (anchor.getUTCDay() + 6) % 7;
  const monday = new Date(anchor);
  monday.setUTCDate(monday.getUTCDate() - mondayOffset);
  const nextMonday = new Date(monday);
  nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);

  const weekEvents = await db
    .select({ startAt: eventsTable.startAt })
    .from(eventsTable)
    .where(
      and(
        inArray(eventsTable.status, ["published", "cancelled"]),
        gte(eventsTable.startAt, new Date(`${isoDate(monday)}T00:00:00.000Z`)),
        lt(
          eventsTable.startAt,
          new Date(`${isoDate(nextMonday)}T08:00:00.000Z`),
        ),
      ),
    );

  const counts = new Map<string, number>();
  for (const event of weekEvents) {
    const date = vancouverDate(event.startAt);
    if (date >= isoDate(monday) && date < isoDate(nextMonday)) {
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
  }
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(date.getUTCDate() + index);
    const day = isoDate(date);
    return { date: day, eventCount: counts.get(day) ?? 0 };
  });

  res.json(
    GetCalendarOverviewResponse.parse({
      weekStart: isoDate(monday),
      weekEnd: isoDate(new Date(nextMonday.getTime() - 24 * 60 * 60 * 1000)),
      days,
    }),
  );
});

router.get("/admin/status", async (req, res): Promise<void> => {
  let isAdmin = false;
  const userId = getAuth(req).userId;
  if (userId && configuredAdminEmails().size > 0) {
    try {
      isAdmin = await isAdministrator(req);
    } catch (error) {
      req.log.error({ err: error }, "Unable to check administrator status");
      res.status(503).json({ error: "Administrator status could not be checked" });
      return;
    }
  }
  const emailDeliveryConfigured = getEmailDeliveryStatus().configured;
  res.json(
    GetAdminStatusResponse.parse({
      isAdmin,
      emailDeliveryConfigured,
      adminSetupRequired: configuredAdminEmails().size === 0,
    }),
  );
});

router.get("/admin/events", requireAdmin, async (_req, res): Promise<void> => {
  const events = await db
    .select()
    .from(eventsTable)
    .orderBy(desc(eventsTable.updatedAt), asc(eventsTable.startAt));
  res.json(ListAdminEventsResponse.parse(events.map(eventResponse)));
});

router.post("/admin/events", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid event details" });
    return;
  }

  const data = parsed.data;
  const [created] = await db
    .insert(eventsTable)
    .values({
      ...data,
      slug: slugFor(data.title),
      startAt: new Date(data.startAt),
      endAt: data.endAt ? new Date(data.endAt) : null,
      lastVerifiedAt: data.lastVerifiedAt ? new Date(data.lastVerifiedAt) : null,
      status: data.status ?? "draft",
      isDemo: data.isDemo ?? false,
      tags: data.tags ?? [],
    })
    .returning();

  res.status(201).json(CreateEventResponse.parse(eventResponse(created)));
});

router.patch(
  "/admin/events/:id",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = UpdateEventParams.safeParse(req.params);
    const parsed = UpdateEventBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid event update" });
      return;
    }

    const data = parsed.data;
    const update = {
      ...data,
      startAt: data.startAt ? new Date(data.startAt) : undefined,
      endAt:
        data.endAt === null
          ? null
          : data.endAt
            ? new Date(data.endAt)
            : undefined,
      lastVerifiedAt:
        data.lastVerifiedAt === null
          ? null
          : data.lastVerifiedAt
            ? new Date(data.lastVerifiedAt)
            : undefined,
      updatedAt: new Date(),
    };
    delete (update as { slug?: string }).slug;

    const [updated] = await db
      .update(eventsTable)
      .set(update)
      .where(eq(eventsTable.id, params.data.id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    res.json(UpdateEventResponse.parse(eventResponse(updated)));
  },
);

router.delete(
  "/admin/events/:id",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = DeleteEventParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid event ID" });
      return;
    }
    const [removed] = await db
      .delete(eventsTable)
      .where(eq(eventsTable.id, params.data.id))
      .returning({ id: eventsTable.id });
    if (!removed) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    res.sendStatus(204);
  },
);

export async function seedDemoEvents(): Promise<void> {
  const [existing] = await db
    .select({ id: eventsTable.id })
    .from(eventsTable)
    .limit(1);
  if (existing) {
    return;
  }

  const now = new Date();
  const monday = new Date(now);
  monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7));
  monday.setUTCHours(18, 0, 0, 0);
  const addDays = (base: Date, days: number, hours: number) => {
    const date = new Date(base);
    date.setUTCDate(date.getUTCDate() + days);
    date.setUTCHours(hours, 0, 0, 0);
    return date;
  };

  await db.insert(eventsTable).values([
    {
      slug: slugFor("Sample community gathering"),
      title: "Sample: Community gathering",
      summary: "A demonstration listing for the community calendar.",
      description:
        "Sample content for the proof of concept only. This is not a real community event; confirm details with an organizer before sharing.",
      category: "Community Events",
      startAt: monday,
      allDay: false,
      location: "Sample venue — confirm with organizer",
      sourceUrl: null,
      status: "published",
      isDemo: true,
    },
    {
      slug: slugFor("Sample family activity"),
      title: "Sample: Family activity",
      summary: "Example content to demonstrate event browsing and filters.",
      description:
        "Sample content for the proof of concept only. This is not a real community event; confirm details with an organizer before sharing.",
      category: "Families & Youth",
      startAt: addDays(monday, 2, 23),
      allDay: false,
      location: "Sample venue — confirm with organizer",
      sourceUrl: null,
      status: "published",
      isDemo: true,
    },
    {
      slug: slugFor("Sample recreation notice"),
      title: "Sample: Recreation program notice",
      summary: "Demonstration notice, not an official facility update.",
      description:
        "Sample content for the proof of concept only. It is not an official notice or confirmed program.",
      category: "Community Notices",
      startAt: addDays(monday, 4, 19),
      allDay: true,
      location: "Sample facility",
      sourceUrl: null,
      status: "published",
      isDemo: true,
    },
  ]);
}

export default router;
