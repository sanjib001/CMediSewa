import Link from "next/link";
import { requireTenant, can } from "@/lib/auth/context";
import { listRecalls, recallChoices } from "@/lib/inventory/recalls";
import { RecallForm } from "@/components/inventory/recall-form";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Recalls" };
export const dynamic = "force-dynamic";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" });

// Bulk recall (M-51): recall one batch of a medicine in every store at once, and the list of
// past recalls. Each recall shows its lots, stock left per store and who bought it.
export default async function Recalls() {
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_stock", allowPendingTenant: true, next: "/admin/stock/recalls" });
  const canRecall = can(ctx, "block_batches");
  const [recalls, choices] = await Promise.all([listRecalls(ctx.tenantId), canRecall ? recallChoices(ctx.tenantId) : Promise.resolve([])]);
  return (
    <>
      <PageHeader title="Recalls" subtitle={<><Link href="/admin/stock" className="text-pine hover:underline">Stock</Link> / when a maker or the DDA recalls a batch</>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,26rem)_1fr]">
        {canRecall ? (
          <Panel title="Recall a batch">
            <p className="mb-3 text-sm text-ink-soft">Every lot of the medicine with this batch number, in every store, stops being sold at once. Staff who sell and manage stock are told. You&apos;ll then see what is left in each store and who bought it.</p>
            <RecallForm items={choices} />
          </Panel>
        ) : null}
        <Panel title="Past recalls" flush>
          {recalls.length === 0 ? <p className="px-5 py-4 text-ink-soft">No recalls yet.</p> : (
            <ul className="divide-y divide-line">{recalls.map((r) => (
              <li key={r.id} className="px-5 py-3">
                <Link href={`/admin/stock/recalls/${r.id}`} className="font-medium text-pine hover:underline">{r.item}, batch {r.batch_no}</Link>
                <span className="block text-sm text-ink-soft">{when(r.at)}{r.by ? ` by ${r.by}` : ""}: {r.reason}{r.reference ? ` (${r.reference})` : ""}</span>
              </li>))}</ul>
          )}
        </Panel>
      </div>
    </>
  );
}
