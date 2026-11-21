import Link from "next/link";
import { requireTenant, can } from "@/lib/auth/context";
import { runReport, type Col, type Row } from "@/lib/reports/data";
import { patientsWithDues } from "@/lib/pharmacy/data";
import { todayIn } from "@/lib/desk/data";
import { ReportTable } from "@/components/reports/report-table";
import { CollectDues } from "@/components/pharmacy/bill-corrections";
import { LiveRefresh } from "@/components/notify/live-refresh";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const SOURCE: Record<string, string> = { visit: "OPD", counter: "Pharmacy", dispensing: "Pharmacy" };
const COLS: Col[] = [
  { key: "invoice_no", label: "Bill", kind: "text", link: (r) => `/admin/billing/${r.invoice_id}` }, { key: "issued_at", label: "Time", kind: "time" },
  { key: "source_label", label: "From", kind: "text" }, { key: "customer", label: "Customer", kind: "text" }, { key: "total", label: "Total", kind: "money" },
  { key: "returned", label: "Returned", kind: "money" }, { key: "paid", label: "Paid", kind: "money" }, { key: "outstanding", label: "Owed", kind: "money" },
  { key: "status", label: "Status", kind: "text" }, { key: "issued_by", label: "By", kind: "text" },
];

// Billing (U3): every bill of a period from the front desk and the pharmacy, and who owes what.
// Each bill opens the printable view with its corrections (collect, return, void today).
export default async function Billing({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; from_src?: string }> }) {
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_billing", allowPendingTenant: true, next: "/admin/billing" });
  const sp = await searchParams;
  const today = todayIn();
  const to = sp.to && DATE.test(sp.to) && sp.to <= today ? sp.to : today;
  const from = sp.from && DATE.test(sp.from) && sp.from <= to && shift(sp.from, 400) >= to ? sp.from : to;
  const src = sp.from_src === "visit" || sp.from_src === "counter" ? sp.from_src : "";
  const [all, dues] = await Promise.all([runReport(ctx.tenantId, "sales", { from, to, days: 0, store: null }), patientsWithDues(ctx.tenantId)]);
  const rows: Row[] = all.filter((r) => !src || (src === "visit" ? r.source === "visit" : r.source !== "visit")).map((r) => ({ ...r, source_label: SOURCE[String(r.source)] ?? String(r.source) }));
  const live = rows.filter((r) => r.status === "issued");
  const q = (f: string, t: string, s = src) => `/admin/billing?from=${f}&to=${t}${s ? `&from_src=${s}` : ""}`;
  const canCollect = can(ctx, "manage_billing") || can(ctx, "pharmacy_sell");
  return (
    <>
      <LiveRefresh topics={["billing"]} />
      <PageHeader title="Billing" subtitle={`${live.length} bill${live.length === 1 ? "" : "s"}, ${npr(live.reduce((s, r) => s + Number(r.total), 0))}${from === to ? (to === today ? " today" : ` on ${to}`) : ` from ${from} to ${to}`}.`} />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        {([["Today", today, today], ["Yesterday", shift(today, -1), shift(today, -1)], ["Last 7 days", shift(today, -6), today]] as [string, string, string][]).map(([t, f, e]) => (
          <Link key={t} href={q(f, e)} className={cn("rounded-control border px-3 py-2", from === f && to === e ? "border-pine bg-pine/5 font-medium" : "border-line-strong")}>{t}</Link>))}
        <form action="/admin/billing" className="flex flex-wrap items-end gap-2">
          <label><span className="block text-xs text-ink-faint">From</span><input type="date" name="from" defaultValue={from} max={today} className="rounded-control border border-line-strong px-2 py-1.5" /></label>
          <label><span className="block text-xs text-ink-faint">To</span><input type="date" name="to" defaultValue={to} max={today} className="rounded-control border border-line-strong px-2 py-1.5" /></label>
          <label><span className="block text-xs text-ink-faint">Bills from</span><select name="from_src" defaultValue={src} className="rounded-control border border-line-strong px-2 py-1.5"><option value="">OPD and pharmacy</option><option value="visit">OPD only</option><option value="counter">Pharmacy only</option></select></label>
          <button className="rounded-control border border-line-strong px-3 py-1.5">Show</button>
        </form>
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.7fr_1fr]">
        <Panel title="Bills" flush><ReportTable cols={COLS} rows={rows} /></Panel>
        <Panel title="Patients who owe" aside={dues.length ? <span className="text-sm text-ink-faint">{npr(dues.reduce((s, d) => s + d.owed, 0))}</span> : null} flush>
          {dues.length === 0 ? <p className="px-5 py-4 text-ink-soft">Nobody owes anything.</p> : (
            <ul className="divide-y divide-line">{dues.map((d) => (
              <li key={d.patient_id} className="space-y-2 px-5 py-3">
                <div><span className="font-medium">{d.name}</span> <span className="text-sm text-ink-faint">{d.mrn}{d.phone ? `, ${d.phone}` : ""}</span>
                  <div className="text-sm text-ink-soft">{npr(d.owed)} on {d.bills} bill{d.bills > 1 ? "s" : ""}</div></div>
                {canCollect ? <CollectDues key={`${d.patient_id}:${d.owed}`} patientId={d.patient_id} owed={d.owed} /> : null}
              </li>))}</ul>
          )}
        </Panel>
      </div>
    </>
  );
}
