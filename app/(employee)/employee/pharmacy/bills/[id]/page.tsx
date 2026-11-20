import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { getBill } from "@/lib/pharmacy/data";
import { PrintButton } from "@/components/pharmacy/print-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bill" };

const n2 = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// A pharmacy bill, laid out to print on A5 or a receipt printer (the shell hides on print).
export default async function Bill({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenant({ operation: "pharmacy.counter", permission: "pharmacy_sell", next: "/employee/pharmacy" });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const b = await getBill(ctx.tenantId, id);
  if (!b) notFound();
  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-4 flex justify-between print:hidden">
        <Link href="/employee/pharmacy?tab=bills" className="text-pine hover:underline">Back to bills</Link>
        <PrintButton />
      </div>
      <article className="rounded-panel border border-line bg-surface p-6 text-[0.92rem] print:border-0 print:p-0">
        <header className="text-center">
          <h1 className="text-lg font-semibold">{b.profile.name}</h1>
          {b.profile.address ? <p>{b.profile.address}</p> : null}
          <p>{[b.profile.phone, b.profile.pan ? `PAN ${b.profile.pan}` : null].filter(Boolean).join(", ")}</p>
          <p className="mt-2 font-medium">{b.tax > 0 ? "Tax invoice" : "Invoice"}{b.status === "void" ? " (VOID)" : ""}</p>
        </header>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 text-sm">
          <div>Bill no. <strong>{b.invoice_no}</strong></div><div className="text-right">FY {b.fiscal_year}</div>
          <div>{new Date(b.issued_at).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" })}</div><div className="text-right">{b.store}</div>
          <div className="col-span-2 mt-1">Customer: {b.customer}{b.phone ? `, ${b.phone}` : ""}</div>
          {b.external_rx ? <div className="col-span-2">Prescribed by {b.external_rx.prescriber_name}{b.external_rx.prescriber_reg_no ? ` (${b.external_rx.prescriber_reg_no})` : ""}{b.external_rx.facility ? `, ${b.external_rx.facility}` : ""}, {b.external_rx.rx_date}</div> : null}
        </dl>
        <table className="mt-4 w-full text-left">
          <thead className="border-y border-line text-xs"><tr><th className="py-1">Item</th><th className="py-1 text-right">Qty</th><th className="py-1 text-right">Rate</th><th className="py-1 text-right">Amount</th></tr></thead>
          <tbody>{b.lines.map((l) => (
            <tr key={l.n} className="align-top">
              <td className="py-1">{l.text}{l.lots ? <span className="block text-xs text-ink-faint">Batch {l.lots}</span> : null}{l.discount ? <span className="block text-xs">less {n2(l.discount)}</span> : null}</td>
              <td className="py-1 text-right">{l.qty} {l.unit}</td><td className="py-1 text-right tabular-nums">{n2(l.price)}</td><td className="py-1 text-right tabular-nums">{n2(l.total)}</td>
            </tr>))}</tbody>
        </table>
        <dl className="mt-3 space-y-0.5 border-t border-line pt-2 text-right tabular-nums">
          <div>Subtotal {n2(b.subtotal)}</div>
          {b.discount ? <div>Discount −{n2(b.discount)}</div> : null}
          {b.tax ? <div>VAT 13% {n2(b.tax)}</div> : null}
          <div className="text-base font-semibold">Total Rs. {n2(b.total)}</div>
          <div>Paid {n2(b.paid)}{b.total - b.paid > 0 ? `, due ${n2(b.total - b.paid)}` : ""}</div>
        </dl>
        <footer className="mt-4 text-center text-xs text-ink-faint">Issued by {b.by}.{b.profile.footer ? ` ${b.profile.footer}` : ""}</footer>
      </article>
    </div>
  );
}
