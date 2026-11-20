import { timingSafeEqual } from "node:crypto";
import { serviceClient } from "@/lib/supabase/service";

// Daily subscription expiry (W-33): suspends active clinics whose paid-until date has passed.
// Secret-gated (x-cron-secret == CRON_SECRET, constant-time) and 404 otherwise, the same
// posture as HRestroSewa's cron routes. Scheduling (pg_cron / Vercel Cron) is set up with
// hosting; until then it can be called by hand.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorised(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const a = Buffer.from(req.headers.get("x-cron-secret") ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!authorised(req)) return new Response("Not found", { status: 404 });
  const { data, error } = await serviceClient().rpc("suspend_expired_tenants");
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  return Response.json({ ok: true, suspended: data });
}
