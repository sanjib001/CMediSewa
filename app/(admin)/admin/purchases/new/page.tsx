import Link from "next/link";
import { requireTenant } from "@/lib/auth/context";
import { listVendors } from "@/lib/purchasing/data";
import { listStores } from "@/lib/inventory/data";
import { serviceClient } from "@/lib/supabase/service";
import { PurchaseForm } from "@/components/purchasing/purchase-form";
import { PageHeader } from "@/components/ui/primitives";

export const metadata = { title: "Enter a bill" };
export const dynamic = "force-dynamic";

export default async function NewPurchase({ searchParams }: { searchParams: Promise<{ vendor?: string }> }) {
  const ctx = await requireTenant({ operation: "stock.post", permission: "manage_purchases", allowPendingTenant: true, next: "/admin/purchases/new" });
  const [vendors, { stores }] = await Promise.all([listVendors(ctx.tenantId), listStores(ctx.tenantId)]);
  const db = serviceClient();
  const receiving = [];
  for (const s of stores.filter((x) => x.is_active && x.is_receiving)) {
    const { data } = await db.rpc("store_access", { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_store: s.id });
    if (data === "manage" || data === "operate") receiving.push({ id: s.id, name: s.name });
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(new Date());
  const active = vendors.filter((v) => v.is_active);
  return (
    <>
      <PageHeader title="Enter a vendor bill" subtitle={<><Link href="/admin/purchases" className="text-pine hover:underline">Purchases</Link> / copy the bill line by line. Each line is received as its own batch.</>} />
      {!active.length ? <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">Add a vendor first in <Link href="/admin/vendors" className="text-pine underline">Vendors</Link>.</p>
        : !receiving.length ? <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">You don&apos;t work in a store that receives stock. Ask an admin to add you in Stock &amp; stores.</p>
        : <PurchaseForm vendors={active.map((v) => ({ id: v.id, name: v.name }))} stores={receiving} defaultVendor={(await searchParams).vendor} today={today} />}
    </>
  );
}
