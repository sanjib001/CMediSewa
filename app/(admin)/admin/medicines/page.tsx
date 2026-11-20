import Link from "next/link";
import { requireTenant, can } from "@/lib/auth/context";
import { listItems, packText } from "@/lib/inventory/data";
import { ButtonLink, PageHeader } from "@/components/ui/primitives";

export const metadata = { title: "Medicines" };
export const dynamic = "force-dynamic";

const SCHEDULE: Record<string, string> = { otc: "OTC", prescription_only: "Rx only", controlled: "Controlled", narcotic: "Narcotic" };

export default async function Medicines({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_stock", allowPendingTenant: true, next: "/admin/medicines" });
  const q = String((await searchParams).q ?? "").slice(0, 60);
  const items = await listItems(ctx.tenantId, q);
  return (
    <>
      <PageHeader title="Medicines & items" subtitle="Everything the clinic stocks. Quantities are across all stores."
        actions={can(ctx, "manage_items") ? <ButtonLink href="/admin/medicines/new">Add item</ButtonLink> : null} />
      <form className="mb-4 flex max-w-md gap-2" action="/admin/medicines">
        <input name="q" defaultValue={q} placeholder="Search by name or code" className="w-full rounded-control border border-line-strong bg-surface px-3 py-2" />
      </form>
      {items.length === 0 ? (
        <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">{q ? "Nothing matches." : "No items yet. Add your medicines, then enter opening stock in Stock & stores."}</p>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full min-w-[42rem] text-left text-[0.95rem]">
            <thead className="text-sm text-ink-faint"><tr>
              <th className="px-4 py-2 font-medium">Item</th><th className="py-2 font-medium">Generic, strength, form</th>
              <th className="py-2 font-medium">Rule</th><th className="px-4 py-2 text-right font-medium">In stock</th></tr></thead>
            <tbody className="divide-y divide-line">
              {items.map((i) => {
                const low = i.reorder_level !== null && i.onHand <= i.reorder_level;
                const critical = i.min_stock_level !== null && i.onHand <= i.min_stock_level;
                return (
                  <tr key={i.id} className={i.is_active ? "" : "text-ink-faint"}>
                    <td className="px-4 py-2.5">
                      {can(ctx, "manage_items") ? <Link href={`/admin/medicines/${i.id}`} className="font-medium text-pine hover:underline">{i.name}</Link> : <span className="font-medium">{i.name}</span>}
                      <span className="block text-xs text-ink-faint">{i.item_code}{i.manufacturer ? `, ${i.manufacturer}` : ""}{i.is_active ? "" : ", not in use"}</span>
                    </td>
                    <td className="py-2.5 text-sm text-ink-soft">{[i.generic, i.strength, i.dosage_form].filter(Boolean).join(", ") || i.item_type}</td>
                    <td className="py-2.5 text-sm">{i.schedule_class ? SCHEDULE[i.schedule_class] : ""}</td>
                    <td className={`px-4 py-2.5 text-right text-sm ${critical ? "font-semibold text-alert" : low ? "text-warn" : ""}`}>
                      {packText(i.onHand, i.units)}{critical ? " (critical)" : low ? " (reorder)" : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
