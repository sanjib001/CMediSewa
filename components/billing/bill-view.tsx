import Link from "next/link";
import type { BillDetail } from "@/lib/pharmacy/data";
import { PrintButton } from "@/components/pharmacy/print-button";
import { CollectDues, VoidBill } from "@/components/pharmacy/bill-corrections";
import { Panel } from "@/components/ui/primitives";

const SETTLED = { refund_cash: "cash refund", refund_online: "online refund", reduce_due: "taken off the due" } as const;
const n2 = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * A bill (OPD or pharmacy), laid out to print on A5 or a receipt printer (the shell hides on
 * print), with the corrections the viewer may make below it: collect a due, return items,
 * void (today only). Used by the Pharmacy counter and by Admin → Billing.
 */
export function BillView({ b, back, canCollect, canReturn, canVoid }: {
  b: BillDetail; back: { href: string; label: string }; canCollect: boolean; canReturn: boolean; canVoid: boolean;
}) {
  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-4 flex justify-between print:hidden">
        <Link href={back.href} className="text-pine hover:underline">{back.label}</Link>
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
          <div>Paid {n2(b.paid)}{b.outstanding > 0 ? `, due ${n2(b.outstanding)}` : ""}</div>
        </dl>
        {b.returns.length ? <div className="mt-3 border-t border-line pt-2 text-sm">{b.returns.map((r) => <div key={r.return_no}>Return {r.return_no}: Rs. {n2(r.total)} ({SETTLED[r.settlement as keyof typeof SETTLED] ?? r.settlement})</div>)}</div> : null}
        {b.status === "void" && b.void_reason ? <p className="mt-3 text-sm text-alert">Voided: {b.void_reason}</p> : null}
        <footer className="mt-4 text-center text-xs text-ink-faint">Issued by {b.by}.{b.profile.footer ? ` ${b.profile.footer}` : ""}</footer>
      </article>
      {b.status === "issued" ? (
        <div className="mt-6 space-y-5 print:hidden">
          {canCollect && b.outstanding > 0 && b.patient_id ? <Panel title={`Still owed: Rs. ${n2(b.outstanding)}`}><p className="mb-3 text-sm text-ink-soft">Payments clear this patient&apos;s oldest bill first.</p><CollectDues key={b.outstanding} patientId={b.patient_id} owed={b.outstanding} /></Panel> : null}
          {canReturn && b.lines.some((l) => l.lots) ? <Panel title="Return items"><p className="mb-3 text-sm text-ink-soft">Take back medicines from this bill, batch by batch, and refund or reduce what&apos;s owed.</p>
            <Link href={`/employee/pharmacy/bills/${b.id}/return`} className="rounded-control border border-line-strong px-4 py-2">Return items</Link></Panel> : null}
          {canVoid && b.same_day && !b.returns.length ? <Panel title="Void this bill"><VoidBill id={b.id} /></Panel> : null}
        </div>
      ) : null}
    </div>
  );
}
