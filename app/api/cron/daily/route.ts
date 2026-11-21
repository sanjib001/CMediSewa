import { serviceClient } from "@/lib/supabase/service";
import { cronAuthorised } from "@/lib/cron";

// The daily run (W-19 platform crons), once a night just after midnight in Nepal (vercel.json):
// subscription expiry → suspend, unreviewed booking requests released, no-shows marked,
// the stock alert notification, subscription-ending warnings, sign-in record housekeeping,
// then the ledger, payables and books checks (reconcile_all_tenants).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  if (!cronAuthorised(req)) return new Response("Not found", { status: 404 });
  const db = serviceClient();
  const jobs = await db.rpc("run_daily_jobs", { p_tenant: null });
  if (jobs.error) return Response.json({ ok: false, error: jobs.error.message }, { status: 500 });
  const checks = await db.rpc("reconcile_all_tenants");
  if (checks.error) return Response.json({ ok: false, jobs: jobs.data, error: checks.error.message }, { status: 500 });
  return Response.json({ ok: true, jobs: jobs.data, checks: checks.data });
}
export const GET = handle;
export const POST = handle;
