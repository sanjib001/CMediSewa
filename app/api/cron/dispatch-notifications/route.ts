import { serviceClient } from "@/lib/supabase/service";
import { cronAuthorised } from "@/lib/cron";
import { renderEmail, sendEmail, type EmailPayload, type SendResult } from "@/lib/notify/email";
import { sendPush } from "@/lib/notify/push";

// Notification dispatcher (W-19), every 5 minutes: claims due outbox rows (skip locked),
// sends each email or push, and records the result (retry with backoff, failed after 5).
// With no mail key, emails are marked "skipped (dry run)". Also prunes old events and rows.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type OutboxRow = { id: number; tenant_id: string; channel: "email" | "push"; kind: string; recipient: string; payload: Record<string, unknown> };

async function run() {
  const db = serviceClient();
  const counts = { sent: 0, skipped: 0, retry: 0, failed: 0 };
  const started = Date.now();
  while (Date.now() - started < 45_000) {
    const { data, error } = await db.rpc("claim_outbox", { p_limit: 50 });
    if (error) throw new Error(`claim: ${error.message}`);
    const rows = (data ?? []) as OutboxRow[];
    if (!rows.length) break;
    for (const r of rows) {
      let out: SendResult & { gone?: boolean };
      if (r.channel === "email") {
        const msg = renderEmail(r.kind, r.payload as unknown as EmailPayload);
        out = msg ? await sendEmail(r.recipient, msg, String(r.payload.clinic ?? "Clinic")) : { result: "failed", error: `no template for ${r.kind}` };
      } else {
        const { data: sub } = await db.from("push_subscriptions").select("endpoint, p256dh, auth, disabled_at").eq("id", r.recipient).maybeSingle();
        out = !sub || sub.disabled_at ? { result: "skipped", error: "device removed" }
          : await sendPush(sub, { title: String(r.payload.title ?? ""), body: (r.payload.body as string) ?? null, link: (r.payload.link as string) ?? null });
      }
      await db.rpc("complete_outbox", { p_id: r.id, p_result: out.result, p_error: out.error ?? null, p_disable: Boolean(out.gone) });
      counts[out.result]++;
    }
  }
  const { data: pruned } = await db.rpc("prune_notifications");
  return { ...counts, pruned };
}

async function handle(req: Request) {
  if (!cronAuthorised(req)) return new Response("Not found", { status: 404 });
  try {
    return Response.json({ ok: true, ...(await run()) });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;
