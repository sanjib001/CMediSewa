import Link from "next/link";
import { requireTenant } from "@/lib/auth/context";
import { getOrder, listVendors } from "@/lib/purchasing/data";
import { listItems, listStores } from "@/lib/inventory/data";
import { serviceClient } from "@/lib/supabase/service";
import { PurchaseForm, type PoPrefill } from "@/components/purchasing/purchase-form";
import { PageHeader } from "@/components/ui/primitives";

export const metadata = { title: "Enter a bill" };
export const dynamic = "force-dynamic";

export default async function NewPurchase({ searchParams }: { searchParams: Promise<{ vendor?: string; po?: string }> }) {
  const ctx = await requireTenant({ operation: "stock.post", permission: "manage_purchases", allowPendingTenant: true, next: "/admin/purchases/new" });
  const sp = await searchParams;
  const [vendors, { stores }] = await Promise.all([listVendors(ctx.tenantId), listStores(ctx.tenantId)]);
  const db = serviceClient();
  const receiving = [];
  for (const s of stores.filter((x) => x.is_active && x.is_receiving)) {
    const { data } = await db.rpc("store_access", { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_store: s.id });
    if (data === "manage" || data === "operate") receiving.push({ id: s.id, name: s.name });
  }
  // Receiving an order: start from what's still to come on it.
  let po: PoPrefill | null = null;
  if (sp.po && /^[0-9a-f-]{36}$/.test(sp.po)) {
    const order = await getOrder(ctx.tenantId, sp.po);
    if (order && ["open", "partially_received"].includes(order.head.status)) {
      const items = await listItems(ctx.tenantId);
      po = {
        poId: order.head.id, poNo: order.head.po_no, vendorId: order.head.vendor_id, storeId: order.head.deliver_to_store_id,
        lines: order.lines.filter((l) => l.remaining_units > 0 && items.some((i) => i.id === l.item_id)).map((l) => ({
          po_line_id: l.id, item: items.find((i) => i.id === l.item_id)!, unit_id: l.unit_id, qty: l.remaining_units,
          unit_cost: l.expected_unit_cost === null ? null : Number(l.expected_unit_cost) })),
      };
    }
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(new Date());
  const active = vendors.filter((v) => v.is_active);
  return (
    <>
      <PageHeader title="Enter a vendor bill" subtitle={<><Link href="/admin/purchases" className="text-pine hover:underline">Purchases</Link> / copy the bill line by line. Each line is received as its own batch.</>} />
      {!active.length ? <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">Add a vendor first in <Link href="/admin/vendors" className="text-pine underline">Vendors</Link>.</p>
        : !receiving.length ? <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">You don&apos;t work in a store that receives stock. Ask an admin to add you in Stock &amp; stores.</p>
        : <PurchaseForm vendors={active.map((v) => ({ id: v.id, name: v.name }))} stores={receiving} defaultVendor={sp.vendor} today={today} po={po} />}
    </>
  );
}
