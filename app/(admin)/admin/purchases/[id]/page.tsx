import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant, can } from "@/lib/auth/context";
import { getPurchase } from "@/lib/purchasing/data";
import { VoidPurchase } from "@/components/purchasing/void-purchase";
import { ButtonLink, PageHeader, Panel } from "@/components/ui/primitives";
import { PrintButton } from "@/components/pharmacy/print-button";

export const metadata = { title: "Purchase" };
export const dynamic = "force-dynamic";

const npr = (n: unknown) => `Rs. ${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function Purchase({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_purchases", allowPendingTenant: true, next: `/admin/purchases/${id}` });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const p = await getPurchase(ctx.tenantId, id);
  if (!p) notFound();
  const h = p.head as Record<string, string | number | null>;
  const isVoid = h.status === "void";
  return (
    <>
      <PageHeader title={`${h.purchase_no}${isVoid ? " (void)" : ""}`}
        subtitle={<><Link href="/admin/purchases" className="text-pine hover:underline">Purchases</Link> / {p.vendor?.name} bill #{h.vendor_invoice_no} of {h.vendor_invoice_date}{p.store ? `, received into ${p.store}` : ""}.</>}
        actions={<div className="flex gap-2 print:hidden"><PrintButton />{!isVoid && h.kind === "purchase" && can(ctx, "return_to_vendor") ? <ButtonLink tone="secondary" href={`/admin/purchases/returns/new?invoice=${id}`}>Return items from this bill</ButtonLink> : null}</div>} />
      <p className="mb-4 hidden text-lg font-semibold print:block">Goods received note: {h.purchase_no}{isVoid ? " (VOID)" : ""}</p>
      {isVoid ? <p className="mb-6 rounded-panel bg-alert-tint p-4 text-alert">Voided: {h.void_reason}</p> : null}
      <div className="grid gap-6 xl:grid-cols-[1.7fr_1fr]">
        <Panel title="Lines" flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="text-ink-faint"><tr><th className="px-5 py-2 font-medium">Item</th><th className="py-2 font-medium">Batch, expiry</th><th className="py-2 text-right font-medium">Qty</th>
                <th className="py-2 text-right font-medium">Rate</th><th className="py-2 text-right font-medium">Net</th><th className="px-5 py-2 text-right font-medium">Cost per base unit</th></tr></thead>
              <tbody className="divide-y divide-line">
                {p.lines.map((l) => (
                  <tr key={l.line_no}>
                    <td className="px-5 py-2 font-medium">{l.item}</td>
                    <td className="py-2 font-mono">{l.batch_no} <span className="font-sans text-ink-faint">{l.expiry_date ?? ""}</span></td>
                    <td className="py-2 text-right">{Number(l.qty)} {l.unit}{Number(l.free_qty) ? ` + ${Number(l.free_qty)} free` : ""}</td>
                    <td className="py-2 text-right tabular-nums">{npr(l.unit_cost)}{Number(l.discount_pct) ? <span className="block text-xs text-ink-faint">−{Number(l.discount_pct)}%</span> : null}</td>
                    <td className="py-2 text-right tabular-nums">{npr(l.line_net)}{Number(l.tax_rate) ? <span className="block text-xs text-ink-faint">+VAT {npr(l.tax_amount)}</span> : null}</td>
                    <td className="px-5 py-2 text-right tabular-nums">{npr(l.lot_cost_base)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <div className="space-y-6">
          <Panel title="Amounts">
            <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-[0.95rem]">
              <dt className="text-ink-soft">Gross</dt><dd className="text-right tabular-nums">{npr(h.subtotal)}</dd>
              <dt className="text-ink-soft">Line discounts</dt><dd className="text-right tabular-nums">− {npr(h.line_discount_total)}</dd>
              {Number(h.bill_discount) ? <><dt className="text-ink-soft">Bill discount</dt><dd className="text-right tabular-nums">− {npr(h.bill_discount)}</dd></> : null}
              <dt className="text-ink-soft">VAT</dt><dd className="text-right tabular-nums">{npr(h.tax_amount)}</dd>
              <dt className="border-t border-line pt-1.5 font-semibold">Total</dt><dd className="border-t border-line pt-1.5 text-right font-semibold tabular-nums">{npr(h.total)}</dd>
              <dt className="text-ink-soft">Paid at receipt</dt><dd className="text-right tabular-nums">{npr(Number(h.paid_cash) + Number(h.paid_online))}</dd>
              <dt className="text-ink-soft">Paid later</dt><dd className="text-right tabular-nums">{npr(p.paidLater)}</dd>
              <dt className="font-medium">Still owed</dt><dd className="text-right font-medium tabular-nums">{npr(p.outstanding)}</dd>
            </dl>
          </Panel>
          {!isVoid && can(ctx, "manage_purchases") ? (
            <Panel title="Entered by mistake?"><VoidPurchase id={id} /></Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
