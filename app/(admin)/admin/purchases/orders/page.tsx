import Link from "next/link";
import { requireTenant, can } from "@/lib/auth/context";
import { listOrders, listVendors } from "@/lib/purchasing/data";
import { listStores } from "@/lib/inventory/data";
import { NewOrder } from "@/components/purchasing/orders";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Purchase orders" };
export const dynamic = "force-dynamic";

const ORDER_STATUS: Record<string, [string, string]> = {
  open: ["Waiting", "text-warn"], partially_received: ["Part received", "text-marigold-ink"], received: ["Received", "text-ok"],
  closed: ["Closed", "text-ink-faint"], cancelled: ["Cancelled", "text-ink-faint"],
};

export default async function Orders() {
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_purchases", allowPendingTenant: true, next: "/admin/purchases/orders" });
  const [orders, vendors, { stores }] = await Promise.all([listOrders(ctx.tenantId), listVendors(ctx.tenantId), listStores(ctx.tenantId)]);
  const vname = (id: string) => vendors.find((v) => v.id === id)?.name ?? "";
  return (
    <>
      <PageHeader title="Purchase orders" subtitle={<><Link href="/admin/purchases" className="text-pine hover:underline">Purchases</Link> / what you&apos;ve asked vendors for. Receiving a bill against an order fills it in. Tip: start from <Link href="/admin/stock/reorder" className="text-pine underline">Reorder</Link>.</>} />
      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Panel title="Orders" flush>
          {orders.length === 0 ? <p className="px-5 py-4 text-ink-soft">No orders yet.</p> : (
            <ul className="divide-y divide-line">{orders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-baseline gap-x-4 px-5 py-3">
                <Link href={`/admin/purchases/orders/${o.id}`} className="font-medium text-pine hover:underline">{o.po_no}</Link>
                <span className="flex-1">{vname(o.vendor_id)}</span>
                <span className={`text-sm font-medium ${ORDER_STATUS[o.status]?.[1]}`}>{ORDER_STATUS[o.status]?.[0]}</span>
                <span className="text-sm text-ink-faint">{o.expected_date ? `expected ${o.expected_date}` : o.created_at.slice(0, 10)}</span>
              </li>))}</ul>
          )}
        </Panel>
        {can(ctx, "manage_purchases") && vendors.some((v) => v.is_active) ? (
          <Panel title="New order"><NewOrder vendors={vendors.filter((v) => v.is_active).map((v) => ({ id: v.id, name: v.name }))} stores={stores.filter((s) => s.is_active && s.is_receiving).map((s) => ({ id: s.id, name: s.name }))} /></Panel>
        ) : null}
      </div>
    </>
  );
}
