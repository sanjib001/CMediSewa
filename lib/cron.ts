import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Cron routes are secret-gated: either `x-cron-secret: <CRON_SECRET>` (manual or another
 * scheduler) or `Authorization: Bearer <CRON_SECRET>` (what Vercel Cron sends). Constant-time
 * compare; a route answers 404 otherwise. With no CRON_SECRET set, nothing is authorised.
 */
export function cronAuthorised(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  const given = req.headers.get("x-cron-secret") ?? bearer ?? "";
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
