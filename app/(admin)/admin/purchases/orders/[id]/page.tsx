import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant, can } from "@/lib/auth/context";
import { getOrder, listVendors } from "@/lib/purchasing/data";
import { listStores } from "@/lib/inventory/data";
import { EndOrder } from "@/components/purchasing/orders";
import { ButtonLink, PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Purchase order" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { open: "Waiting for delivery", partially_received: "Part received", received: "Fully received", closed: "Closed", cancelled: "Cancelled" };

export default async function Order({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_purchases", allowPendingTenant: true, next: `/admin/purchases/orders/${id}` });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const o = await getOrder(ctx.tenantId, id);
  if (!o) notFound();
  const [vendors, { stores }] = await Promise.all([listVendors(ctx.tenantId), listStores(ctx.tenantId)]);
  const live = ["open", "partially_received"].includes(o.head.status);
  return (
    <>
      <PageHeader title={o.head.po_no}
        subtitle={<><Link href="/admin/purchases/orders" className="text-pine hover:underline">Purchase orders</Link> / {vendors.find((v) => v.id === o.head.vendor_id)?.name}, to {stores.find((s) => s.id === o.head.deliver_to_store_id)?.name}. {STATUS[o.head.status]}{o.head.closed_reason ? `: ${o.head.closed_reason}` : ""}.</>}
        actions={live && can(ctx, "manage_purchases") ? <ButtonLink href={`/admin/purchases/new?po=${o.head.id}`}>Receive a bill for this order</ButtonLink> : null} />
      <div className="space-y-6">
        <Panel title="Lines" flush>
          <table className="w-full text-left text-[0.95rem]">
            <thead className="text-sm text-ink-faint"><tr><th className="px-5 py-2 font-medium">Item</th><th className="py-2 text-right font-medium">Ordered</th><th className="py-2 text-right font-medium">Received</th><th className="px-5 py-2 text-right font-medium">Still to come</th></tr></thead>
            <tbody className="divide-y divide-line">{o.lines.map((l) => (
              <tr key={l.id}>
                <td className="px-5 py-2 font-medium">{l.item}</td>
                <td className="py-2 text-right">{l.qty} {l.unit}</td>
                <td className="py-2 text-right">{Math.round((l.received_base / l.factor) * 1000) / 1000} {l.unit}</td>
                <td className={`px-5 py-2 text-right ${l.remaining_units > 0 ? "font-medium" : "text-ink-faint"}`}>{l.remaining_units > 0 ? `${l.remaining_units} ${l.unit}` : "done"}</td>
              </tr>))}</tbody>
          </table>
        </Panel>
        {live && can(ctx, "manage_purchases") ? <EndOrder id={o.head.id} canCancel={o.head.status === "open"} /> : null}
      </div>
    </>
  );
}
