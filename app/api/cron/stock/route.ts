import { timingSafeEqual } from "node:crypto";
import { serviceClient } from "@/lib/supabase/service";

// Nightly stock reconciliation (database.md §9.2): every balance against Σ stock_movements,
// repaired from the ledger and audited when they differ. Secret-gated like the other jobs.
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
  const { data, error } = await serviceClient().rpc("reconcile_all_tenants");
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  return Response.json({ ok: true, ...(data as object) });
}
