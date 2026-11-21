import { serviceClient } from "@/lib/supabase/service";
import { cronAuthorised } from "@/lib/cron";

// Nightly stock reconciliation (database.md §9.2): every balance against Σ stock_movements,
// repaired from the ledger and audited when they differ. Secret-gated like the other jobs.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request) {
  if (!cronAuthorised(req)) return new Response("Not found", { status: 404 });
  const { data, error } = await serviceClient().rpc("reconcile_all_tenants");
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  return Response.json({ ok: true, ...(data as object) });
}
export const GET = handle;
export const POST = handle;
