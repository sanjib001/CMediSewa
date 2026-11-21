import Link from "next/link";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { MarkAllRead } from "@/components/notify/mark-read";
import { PushToggle } from "@/components/notify/push-toggle";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

// My notifications (W-19): booking requests, prescriptions to dispense and other signals for
// this person, newest first; and push notifications for this device.
export default async function Notifications() {
  const ctx = await requireTenant({ operation: "employee.area", allowPendingTenant: true, next: "/employee/notifications" });
  const { data } = await serviceClient().from("notifications").select("id, kind, title, body, link, created_at, read_at")
    .eq("tenant_id", ctx.tenantId).eq("member_id", ctx.memberId).order("created_at", { ascending: false }).limit(100);
  const list = (data ?? []) as { id: string; kind: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null }[];
  const unread = list.filter((n) => !n.read_at).length;
  return (
    <>
      <PageHeader title="Notifications" subtitle={unread ? `${unread} unread` : "You're up to date."} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Panel title="Recent" aside={unread ? <MarkAllRead /> : null} flush>
          {list.length === 0 ? <p className="px-5 py-4 text-ink-soft">Nothing yet. Booking requests and prescriptions to dispense will appear here.</p> : (
            <ul className="divide-y divide-line">{list.map((n) => (
              <li key={n.id} className={cn("px-5 py-3", !n.read_at && "bg-pine/5")}>
                <div className="flex justify-between gap-3">
                  <span className={cn(!n.read_at && "font-medium")}>{n.link ? <Link href={n.link} className="hover:underline">{n.title}</Link> : n.title}</span>
                  <time className="shrink-0 text-sm text-ink-faint" dateTime={n.created_at}>{new Date(n.created_at).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" })}</time>
                </div>
                {n.body ? <p className="text-sm text-ink-soft">{n.body}</p> : null}
              </li>))}</ul>
          )}
        </Panel>
        <Panel title="On this device">
          <p className="mb-3 text-sm text-ink-soft">Get a notification even when CMediSewa isn&apos;t open. It shows the kind of event only, never a diagnosis or medicine.</p>
          <PushToggle publicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null} />
        </Panel>
      </div>
    </>
  );
}
