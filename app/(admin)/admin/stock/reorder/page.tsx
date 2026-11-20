import Link from "next/link";
import { requireTenant, can } from "@/lib/auth/context";
import { getSuggestions, lastReconciliation } from "@/lib/inventory/data";
import { runReconciliation } from "@/app/actions/inventory";
import { ActionForm } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Reorder" };
export const dynamic = "force-dynamic";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// What to buy (items at or below their reorder level, up to the maximum), and the stock
// ledger check. Purchase orders arrive in B6 and will start from this list.
export default async function Reorder() {
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_stock", allowPendingTenant: true, next: "/admin/stock/reorder" });
  const [sug, rec] = await Promise.all([getSuggestions(ctx.tenantId), lastReconciliation(ctx.tenantId)]);
  const total = sug.reduce((s, x) => s + x.est_cost, 0);
  return (
    <>
      <PageHeader title="Reorder" subtitle={<><Link href="/admin/stock" className="text-pine hover:underline">Stock & stores</Link> / items at or below their reorder level, with how much to buy to reach the maximum.</>} />
      <div className="space-y-6">
        <Panel title="Suggested purchases" aside={sug.length ? <span className="text-sm text-ink-faint">About {npr(total)} at the last cost</span> : null} flush>
          {sug.length === 0 ? <p className="px-5 py-4 text-ink-soft">Nothing to reorder. Set reorder levels on items in Medicines to get suggestions.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-[0.95rem]">
                <thead className="text-sm text-ink-faint"><tr><th className="px-5 py-2 font-medium">Item</th><th className="py-2 font-medium">Store</th>
                  <th className="py-2 text-right font-medium">Sellable now</th><th className="py-2 text-right font-medium">Reorder at</th>
                  <th className="py-2 text-right font-medium">Buy</th><th className="px-5 py-2 text-right font-medium">Approx. cost</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {sug.map((s) => (
                    <tr key={`${s.store}-${s.item_id}`}>
                      <td className="px-5 py-2 font-medium">{s.item}</td><td className="py-2 text-sm text-ink-soft">{s.store}</td>
                      <td className="py-2 text-right text-sm">{s.on_hand}</td><td className="py-2 text-right text-sm text-ink-soft">{s.reorder_at ?? "—"}</td>
                      <td className="py-2 text-right font-medium">{s.units} {s.unit}</td><td className="px-5 py-2 text-right text-sm tabular-nums">{npr(s.est_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Stock ledger check" aside={<span className="text-sm text-ink-faint">Runs every night; balances are rebuilt from the ledger if they ever differ</span>}>
          <p className="mb-3 text-ink-soft">
            {rec ? <>Last checked {new Date(rec.ran_at).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu" })}: {rec.checked} balances, {rec.mismatches ? <span className="font-medium text-alert">{rec.mismatches} repaired</span> : "all matched"}.</> : "Not checked yet."}
          </p>
          {can(ctx, "manage_stock") ? <ActionForm action={runReconciliation} submitLabel="Check now" tone="secondary"><></></ActionForm> : null}
        </Panel>
      </div>
    </>
  );
}
