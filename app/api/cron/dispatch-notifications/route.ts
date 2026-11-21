import { serviceClient } from "@/lib/supabase/service";
import { cronAuthorised } from "@/lib/cron";
import { MANAGE_LINK_KINDS, emailConfigured, renderEmail, sendEmail, type EmailPayload, type SendResult } from "@/lib/notify/email";
import { hmac, newToken } from "@/lib/auth/hmac";
import { sendPush } from "@/lib/notify/push";

// Notification dispatcher (W-19), every 5 minutes: claims due outbox rows (skip locked),
// sends each email or push, and records the result (retry with backoff, failed after 5).
// With no mail key, emails are marked "skipped (dry run)". Also prunes old events and rows.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type OutboxRow = { id: number; tenant_id: string; channel: "email" | "push"; kind: string; ref_type: string; ref_id: string; recipient: string; payload: Record<string, unknown> };

async function run() {
  const db = serviceClient();
  const counts = { sent: 0, skipped: 0, retry: 0, failed: 0 };
  const started = Date.now();
  const slugs = new Map<string, string | null>();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  // A fresh private link per email (only when really sending): the token goes in the email,
  // only its HMAC is stored (add_manage_link), exactly like the website's own link.
  const manageLink = async (r: OutboxRow) => {
    if (!appUrl || !emailConfigured() || r.ref_type !== "appointment" || !MANAGE_LINK_KINDS.has(r.kind)) return null;
    if (!slugs.has(r.tenant_id)) slugs.set(r.tenant_id, ((await db.from("tenants").select("slug").eq("id", r.tenant_id).maybeSingle()).data as { slug: string } | null)?.slug ?? null);
    const slug = slugs.get(r.tenant_id);
    if (!slug) return null;
    const token = newToken();
    const { error } = await db.rpc("add_manage_link", { p_appointment: r.ref_id, p_token_hash: hmac("booking", token) });
    return error ? null : `${appUrl}/c/${slug}/booking/${token}`;
  };
  while (Date.now() - started < 45_000) {
    const { data, error } = await db.rpc("claim_outbox", { p_limit: 50 });
    if (error) throw new Error(`claim: ${error.message}`);
    const rows = (data ?? []) as OutboxRow[];
    if (!rows.length) break;
    for (const r of rows) {
      let out: SendResult & { gone?: boolean };
      if (r.channel === "email") {
        const msg = renderEmail(r.kind, r.payload as unknown as EmailPayload, await manageLink(r));
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
