import { serviceClient } from "@/lib/supabase/service";
import { cronAuthorised } from "@/lib/cron";

// Daily subscription expiry (W-33): suspends active clinics whose paid-until date has passed.
// Secret-gated (lib/cron.ts: x-cron-secret or Vercel's Bearer, constant-time) and 404
// otherwise. Scheduled as part of /api/cron/daily (vercel.json); this route stays for manual runs.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request) {
  if (!cronAuthorised(req)) return new Response("Not found", { status: 404 });
  const { data, error } = await serviceClient().rpc("suspend_expired_tenants");
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  return Response.json({ ok: true, suspended: data });
}
export const GET = handle;
export const POST = handle;
