import Link from "next/link";
import type { BillDetail } from "@/lib/pharmacy/data";
import { PrintButton } from "@/components/pharmacy/print-button";
import { CollectDues, VoidBill } from "@/components/pharmacy/bill-corrections";
import { Panel } from "@/components/ui/primitives";
import { adToBs, formatBs, localDate } from "@/lib/clinic-time";
import { amountInWords } from "@/lib/money-words";

const SETTLED = { refund_cash: "cash refund", refund_online: "online refund", reduce_due: "taken off the due", to_advance: "into the advance" } as const;
const n2 = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PAGE: Record<BillDetail["paper"], string> = {
  "80mm": "@page { size: 80mm auto; margin: 3mm; }",
  "58mm": "@page { size: 58mm auto; margin: 2mm; }",
  a5: "@page { size: A5; margin: 10mm; }",
  a4: "@page { size: A4; margin: 14mm; }",
};

/**
 * A bill (OPD or pharmacy), printed on the clinic's receipt paper (Settings: 80 mm or 58 mm
 * thermal, A5 or A4). Only the bill prints; the corrections the viewer may make (collect a due,
 * return items, void today) sit below it on screen. Used by the Pharmacy counter and Admin → Billing.
 */
export function BillView({ b, back, canCollect, canReturn, canVoid }: {
  b: BillDetail; back: { href: string; label: string }; canCollect: boolean; canReturn: boolean; canVoid: boolean;
}) {
  const at = new Date(b.issued_at);
  const bs = formatBs(adToBs(localDate(at)));
  const ad = at.toLocaleDateString("en-GB", { timeZone: "Asia/Kathmandu", day: "2-digit", month: "short", year: "numeric" });
  const time = at.toLocaleTimeString("en-GB", { timeZone: "Asia/Kathmandu", hour: "2-digit", minute: "2-digit" });
  const thermal = b.paper === "80mm" || b.paper === "58mm";
  const customer = b.patientName ?? b.customer;
  const taxable = Math.round((b.subtotal - b.discount) * 100) / 100;
  return (
    <div className="mx-auto max-w-3xl">
      <style>{`@media print { ${PAGE[b.paper]} }`}</style>
      <div className="mb-4 flex items-center justify-between print:hidden">
        <Link href={back.href} className="text-pine hover:underline">{back.label}</Link>
        <span className="flex items-center gap-3 text-sm text-ink-faint">Prints on {thermal ? `${b.paper} receipt paper` : b.paper.toUpperCase()} (Settings) <PrintButton /></span>
      </div>

      <article className="bill print-area rounded-panel border border-line p-5 shadow-sm print:rounded-none print:shadow-none" data-paper={b.paper} aria-label={`Bill ${b.invoice_no}`}>
        <header className="bill-head">
          <h1 className="bill-name">{b.profile.name}</h1>
          {b.profile.address ? <p>{b.profile.address}</p> : null}
          <p>{[b.profile.phone ? `Phone ${b.profile.phone}` : null, b.profile.pan ? `PAN ${b.profile.pan}` : null].filter(Boolean).join(" · ")}</p>
        </header>

        <p className="bill-title">{b.tax > 0 ? "Tax invoice" : "Invoice"}{b.status === "void" ? <span className="bill-void"> · Void</span> : null}</p>

        <dl className="bill-meta">
          <div><dt>Bill no.</dt><dd className="font-semibold">{b.invoice_no}</dd></div>
          <div><dt>Date</dt><dd>{bs} <span className="whitespace-nowrap text-ink-faint">({ad}) {time}</span></dd></div>
          <div><dt>Customer</dt><dd>{customer}</dd></div>
          {b.mrn ? <div><dt>MRN</dt><dd>{b.mrn}</dd></div> : null}
          {b.phone ? <div><dt>Phone</dt><dd>{b.phone}</dd></div> : null}
          {!thermal ? <div><dt>Counter</dt><dd>{b.store} · FY {b.fiscal_year}</dd></div> : null}
          {b.external_rx ? <div className="bill-wide"><dt>Prescribed by</dt><dd>{b.external_rx.prescriber_name}{b.external_rx.prescriber_reg_no ? ` (${b.external_rx.prescriber_reg_no})` : ""}{b.external_rx.facility ? `, ${b.external_rx.facility}` : ""}, {b.external_rx.rx_date}</dd></div> : null}
        </dl>

        <table className="bill-lines">
          <thead><tr>
            <th className="w-6">#</th><th>Particulars</th><th className="num">Qty</th>{!thermal ? <th className="num">Rate</th> : null}<th className="num">Amount</th>
          </tr></thead>
          <tbody>{b.lines.map((l) => (
            <tr key={l.n}>
              <td>{l.n}</td>
              <td>
                <span className="font-medium">{l.text}</span>
                {l.lots ? <span className="bill-sub">Batch {l.lots}</span> : null}
                {thermal ? <span className="bill-sub">@ {n2(l.price)}{l.discount ? `, less ${n2(l.discount)}` : ""}</span> : l.discount ? <span className="bill-sub">Less {n2(l.discount)}</span> : null}
              </td>
              <td className="num">{l.qty} {l.unit}</td>
              {!thermal ? <td className="num">{n2(l.price)}</td> : null}
              <td className="num">{n2(l.total)}</td>
            </tr>))}</tbody>
        </table>

        <dl className="bill-totals">
          <div><dt>Sub-total</dt><dd>{n2(b.subtotal)}</dd></div>
          {b.discount ? <div><dt>Discount</dt><dd>− {n2(b.discount)}</dd></div> : null}
          {b.tax ? <><div><dt>Taxable amount</dt><dd>{n2(taxable)}</dd></div><div><dt>VAT 13%</dt><dd>{n2(b.tax)}</dd></div></> : null}
          <div className="bill-grand"><dt>Total</dt><dd>Rs. {n2(b.total)}</dd></div>
          <div><dt>Paid{b.paidBy.length ? ` (${b.paidBy.join(", ")})` : ""}</dt><dd>{n2(b.paid)}</dd></div>
          {b.outstanding > 0 ? <div className="font-semibold"><dt>Due</dt><dd>{n2(b.outstanding)}</dd></div> : null}
        </dl>
        <p className="bill-words">{amountInWords(b.total)}.</p>

        {b.returns.length ? (
          <div className="bill-returns">{b.returns.map((r) => (
            <p key={r.return_no}>Returned {r.return_no}: Rs. {n2(r.total)} ({SETTLED[r.settlement as keyof typeof SETTLED] ?? r.settlement}) <Link href={`/employee/pharmacy/returns/${r.id}`} className="text-pine hover:underline print:hidden">Print slip</Link></p>
          ))}</div>
        ) : null}
        {b.status === "void" && b.void_reason ? <p className="bill-returns font-semibold">Void: {b.void_reason}</p> : null}

        <footer className="bill-foot">
          {!thermal ? <div className="bill-sign"><span>Received by</span><span>For {b.profile.name}</span></div> : null}
          {b.profile.footer ? <p>{b.profile.footer}</p> : null}
          <p>Issued by {b.by}. Thank you, get well soon.</p>
        </footer>
      </article>

      {b.status === "issued" ? (
        <div className="mx-auto mt-6 max-w-xl space-y-5 print:hidden">
          {canCollect && b.outstanding > 0 && b.patient_id ? <Panel title={`Still owed: Rs. ${n2(b.outstanding)}`}><p className="mb-3 text-sm text-ink-soft">Payments clear this patient&apos;s oldest bill first.</p><CollectDues key={b.outstanding} patientId={b.patient_id} owed={b.outstanding} /></Panel> : null}
          {canReturn && b.lines.some((l) => l.lots) ? <Panel title="Return items"><p className="mb-3 text-sm text-ink-soft">Take back medicines from this bill, batch by batch, and refund or reduce what&apos;s owed.</p>
            <Link href={`/employee/pharmacy/bills/${b.id}/return`} className="rounded-control border border-line-strong px-4 py-2">Return items</Link></Panel> : null}
          {canVoid && b.same_day && !b.returns.length ? <Panel title="Void this bill"><VoidBill id={b.id} /></Panel> : null}
        </div>
      ) : null}
    </div>
  );
}
