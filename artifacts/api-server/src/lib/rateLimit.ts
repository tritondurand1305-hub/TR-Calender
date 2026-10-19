import type { RequestHandler } from "express";

interface WindowEntry {
  count: number;
  resetAt: number;
}

const windows = new Map<string, WindowEntry>();

export function rateLimit({
  name,
  limit,
  windowMs,
}: {
  name: string;
  limit: number;
  windowMs: number;
}): RequestHandler {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${name}:${req.ip || "unknown"}`;
    const existing = windows.get(key);
    const entry =
      !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : existing;

    entry.count += 1;
    windows.set(key, entry);

    if (windows.size > 5000) {
      for (const [storedKey, storedEntry] of windows) {
        if (storedEntry.resetAt <= now) {
          windows.delete(storedKey);
        }
      }
    }

    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - entry.count)));
    res.setHeader(
      "RateLimit-Reset",
      String(Math.ceil((entry.resetAt - now) / 1000)),
    );

    if (entry.count > limit) {
      res.status(429).json({ error: "Too many requests. Please try again later." });
      return;
    }
    next();
  };
}
