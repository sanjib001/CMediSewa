import Link from "next/link";
import { requireTenant } from "@/lib/auth/context";
import { listVendors, returnableLots } from "@/lib/purchasing/data";
import { listStores } from "@/lib/inventory/data";
import { serviceClient } from "@/lib/supabase/service";
import { ReturnForm } from "@/components/purchasing/return-form";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Return to vendor" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/;

// Return stock to the vendor it was bought from (W-44). Choose vendor and store (and optionally
// the bill), then quantities per lot. Expired, blocked and recalled lots can go back.
export default async function NewReturn({ searchParams }: { searchParams: Promise<{ vendor?: string; store?: string; invoice?: string }> }) {
  const ctx = await requireTenant({ operation: "stock.post", permission: "return_to_vendor", allowPendingTenant: true, next: "/admin/purchases/returns/new" });
  const sp = await searchParams;
  const [vendors, { stores }] = await Promise.all([listVendors(ctx.tenantId), listStores(ctx.tenantId)]);
  const db = serviceClient();
  const managed = [];
  for (const s of stores.filter((x) => x.is_active)) {
    const { data } = await db.rpc("store_access", { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_store: s.id });
    if (data === "manage") managed.push(s);
  }
  type Bill = { id: string; vendor_id: string; received_store_id: string; vendor_invoice_no: string };
  let invoice = null as Bill | null;
  if (sp.invoice && UUID.test(sp.invoice)) {
    const { data } = await db.from("purchase_invoices").select("id, vendor_id, received_store_id, vendor_invoice_no").eq("tenant_id", ctx.tenantId).eq("id", sp.invoice).eq("status", "posted").maybeSingle();
    invoice = data as Bill | null;
  }
  const vendorId = invoice?.vendor_id ?? (sp.vendor && UUID.test(sp.vendor) ? sp.vendor : "");
  const storeId = sp.store && managed.some((s) => s.id === sp.store) ? sp.store : invoice?.received_store_id && managed.some((s) => s.id === invoice!.received_store_id) ? invoice.received_store_id : managed[0]?.id ?? "";
  const lots = vendorId && storeId ? await returnableLots(ctx.tenantId, vendorId, storeId, invoice?.id ?? null) : [];
  return (
    <>
      <PageHeader title="Return to vendor" subtitle={<><Link href="/admin/purchases/returns" className="text-pine hover:underline">Returns</Link> / {invoice ? `items from bill #${invoice.vendor_invoice_no}` : "stock bought from a vendor"}.</>} />
      <div className="space-y-6">
        <form className="flex flex-wrap items-end gap-3" action="/admin/purchases/returns/new">
          {invoice ? <input type="hidden" name="invoice" value={invoice.id} /> : (
            <label className="block"><span className="mb-1 block text-sm font-medium">Vendor</span>
              <select name="vendor" defaultValue={vendorId} className="rounded-control border border-line-strong px-3 py-2">{!vendorId ? <option value="">Choose</option> : null}{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
          )}
          <label className="block"><span className="mb-1 block text-sm font-medium">From store</span>
            <select name="store" defaultValue={storeId} className="rounded-control border border-line-strong px-3 py-2">{managed.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <button type="submit" className="rounded-control border border-line-strong px-3 py-2">Show stock</button>
        </form>
        {vendorId && storeId ? <Panel title="What goes back"><ReturnForm vendorId={vendorId} storeId={storeId} invoiceId={invoice?.id ?? null} lots={lots} /></Panel>
          : <p className="text-ink-soft">{managed.length ? "Choose the vendor." : "You don't manage a store."}</p>}
      </div>
    </>
  );
}
