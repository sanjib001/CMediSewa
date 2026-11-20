import Link from "next/link";
import { requireTenant, can } from "@/lib/auth/context";
import { listPurchases, listVendors } from "@/lib/purchasing/data";
import { ButtonLink, PageHeader } from "@/components/ui/primitives";

export const metadata = { title: "Purchases" };
export const dynamic = "force-dynamic";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function Purchases() {
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_purchases", allowPendingTenant: true, next: "/admin/purchases" });
  const [list, vendors] = await Promise.all([listPurchases(ctx.tenantId), listVendors(ctx.tenantId)]);
  const bills = list.filter((b) => b.kind === "purchase");
  const vname = (id: string) => vendors.find((v) => v.id === id)?.name ?? "";
  return (
    <>
      <PageHeader title="Purchases" subtitle="Vendor bills received into stock."
        actions={can(ctx, "manage_purchases") ? <ButtonLink href="/admin/purchases/new">Enter a bill</ButtonLink> : null} />
      {bills.length === 0 ? <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">No bills yet.</p> : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full min-w-[42rem] text-left text-[0.95rem]">
            <thead className="text-sm text-ink-faint"><tr><th className="px-5 py-2 font-medium">Our no.</th><th className="py-2 font-medium">Vendor and bill</th><th className="py-2 font-medium">Date</th>
              <th className="py-2 text-right font-medium">Total</th><th className="px-5 py-2 text-right font-medium">Still owed</th></tr></thead>
            <tbody className="divide-y divide-line">
              {bills.map((b) => (
                <tr key={b.id} className={b.status === "void" ? "text-ink-faint" : ""}>
                  <td className="px-5 py-2.5"><Link href={`/admin/purchases/${b.id}`} className="font-medium text-pine hover:underline">{b.purchase_no}</Link>{b.status === "void" ? <span className="ml-1 text-xs text-alert">void</span> : null}</td>
                  <td className="py-2.5">{vname(b.vendor_id)} <span className="text-ink-faint">#{b.vendor_invoice_no}</span></td>
                  <td className="py-2.5 text-sm">{b.vendor_invoice_date}</td>
                  <td className="py-2.5 text-right tabular-nums">{npr(b.total)}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{b.outstanding > 0 ? npr(b.outstanding) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
