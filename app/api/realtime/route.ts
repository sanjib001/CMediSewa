import { requireTenant, can } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";

// Live updates (D-09 as built for Vercel, D-114): a short Server-Sent Events stream that checks
// the event table every 2 seconds for ~50 seconds, then ends; the browser reconnects at once
// and resumes from Last-Event-ID, so nothing is missed. Events carry a topic only: the page
// refetches through its own permission-checked render.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TOPIC_KEYS: Record<string, string[]> = {
  queue: ["view_queue", "view_appointments", "manage_queue"], bookings: ["view_appointments", "manage_appointments"],
  dispensing: ["dispense_prescription", "pharmacy_sell"], billing: ["view_billing", "pharmacy_sell", "manage_billing"],
  stock: ["view_stock"], notifications: [],
};

export async function GET(req: Request) {
  const ctx = await requireTenant({ operation: "employee.area", allowPendingTenant: true, next: "/employee" });
  const url = new URL(req.url);
  const topics = (url.searchParams.get("topics") ?? "").split(",").filter((t) => t in TOPIC_KEYS)
    .filter((t) => TOPIC_KEYS[t]!.length === 0 || TOPIC_KEYS[t]!.some((k) => can(ctx, k as Parameters<typeof can>[1])));
  if (!topics.length) return new Response("No topics", { status: 400 });
  const db = serviceClient();
  let after = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? NaN);
  if (!Number.isFinite(after)) after = Number((await db.rpc("latest_event_id", { p_tenant: ctx.tenantId })).data ?? 0);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch { /* closed */ } };
      send(`retry: 1000\nid: ${after}\nevent: ready\ndata: ${topics.join(",")}\n\n`);
      const end = Date.now() + 50_000;
      while (Date.now() < end && !req.signal.aborted) {
        const { data } = await db.rpc("events_since", { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_after: after, p_topics: topics });
        const rows = (data ?? []) as { id: number; topic: string }[];
        if (rows.length) {
          after = Number(rows[rows.length - 1]!.id);
          send(`id: ${after}\ndata: ${[...new Set(rows.map((r) => r.topic))].join(",")}\n\n`);
        } else send(`: ping\n\n`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      try { controller.close(); } catch { /* already closed */ }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
