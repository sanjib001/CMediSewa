import Link from "next/link";
import { requireTenant, can } from "@/lib/auth/context";
import { listStores, listTransfers } from "@/lib/inventory/data";
import { NewTransfer, TransferList } from "@/components/inventory/transfers";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Transfers" };
export const dynamic = "force-dynamic";

// Moving stock between stores: request → (approve) → send → receive (D-89, database.md §9.3).
export default async function Transfers() {
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_stock", allowPendingTenant: true, next: "/admin/stock/transfers" });
  const [{ stores }, transfers] = await Promise.all([listStores(ctx.tenantId), listTransfers(ctx.tenantId)]);
  const active = stores.filter((s) => s.is_active);
  return (
    <>
      <PageHeader title="Transfers" subtitle={<><Link href="/admin/stock" className="text-pine hover:underline">Stock & stores</Link> / moving stock between stores. Sending takes the earliest-expiry sellable lots.</>} />
      <div className="space-y-6">
        {can(ctx, "transfer_stock") ? (
          active.length < 2 ? <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">You need at least two stores. Add one in Stock & stores.</p>
            : <Panel title="New transfer"><NewTransfer stores={active.map((s) => ({ id: s.id, name: s.name }))} /></Panel>
        ) : null}
        <Panel title="Transfers"><TransferList transfers={transfers} stores={stores.map((s) => ({ id: s.id, name: s.name }))} /></Panel>
      </div>
    </>
  );
}
