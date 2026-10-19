import { clerkClient, getAuth } from "@clerk/express";
import type { RequestHandler } from "express";

export function configuredAdminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLocaleLowerCase("en-CA"))
      .filter(Boolean),
  );
}

export async function isAdministrator(req: Parameters<typeof getAuth>[0]): Promise<boolean> {
  const userId = getAuth(req).userId;
  const allowlist = configuredAdminEmails();
  if (!userId || allowlist.size === 0) {
    return false;
  }

  const user = await clerkClient.users.getUser(userId);
  return user.emailAddresses.some(
    (address) =>
      address.verification?.status === "verified" &&
      allowlist.has(address.emailAddress.toLocaleLowerCase("en-CA")),
  );
}

export const requireSignedIn: RequestHandler = (req, res, next) => {
  if (!getAuth(req).userId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  next();
};

export const requireAdmin: RequestHandler = async (req, res, next) => {
  if (!getAuth(req).userId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }

  try {
    if (!(await isAdministrator(req))) {
      res.status(403).json({ error: "Administrator access required" });
      return;
    }
    next();
  } catch (error) {
    req.log.error({ err: error }, "Unable to verify administrator access");
    res.status(503).json({ error: "Administrator access could not be verified" });
  }
};
