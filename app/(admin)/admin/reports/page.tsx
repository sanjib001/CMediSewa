import Link from "next/link";
import { redirect } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { REPORTS, allowedReports, columnsFor, reportStores, runReport, seesCost, type ReportKey } from "@/lib/reports/data";
import { todayIn } from "@/lib/desk/data";
import { ReportTable } from "@/components/reports/report-table";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const box = "rounded-control border border-line-strong px-2 py-1.5";

// Reports (database.md §12.3): stock movement, expiry, sales register, item sales, purchase
// register, cash book. Each follows its own permission; cost columns need view_cost_prices.
// CSV download needs an A3 (two-factor) session and is logged.
export default async function Reports({ searchParams }: { searchParams: Promise<{ r?: string; from?: string; to?: string; days?: string; store?: string }> }) {
  const ctx = await requireTenant({ operation: "admin.area", allowPendingTenant: true, next: "/admin/reports" });
  const allowed = allowedReports(ctx);
  if (!allowed.length) redirect("/admin");
  const sp = await searchParams;
  const key: ReportKey = allowed.includes(sp.r as ReportKey) ? (sp.r as ReportKey) : allowed[0]!;
  const def = REPORTS[key];
  const today = todayIn();
  const to = sp.to && DATE.test(sp.to) && sp.to <= today ? sp.to : today;
  const from = sp.from && DATE.test(sp.from) && sp.from <= to && shift(sp.from, 400) >= to ? sp.from : `${to.slice(0, 8)}01`;
  const days = Math.min(730, Math.max(0, Number(sp.days ?? 90) || 90));
  const { stores, all } = def.store ? await reportStores(ctx) : { stores: [], all: true };
  const store = def.store ? (stores.find((s) => s.id === sp.store)?.id ?? (all ? null : stores[0]?.id ?? null)) : null;
  const blocked = def.store && !all && !store;
  const rows = blocked ? [] : await runReport(ctx.tenantId, key, { from, to, days, store });
  const cols = columnsFor(key, seesCost(ctx));
  const qs = new URLSearchParams({ r: key, ...(def.filter === "period" ? { from, to } : def.filter === "day" ? { to } : { days: String(days) }), ...(store ? { store } : {}) });
  return (
    <>
      <PageHeader title="Reports" subtitle={def.about} />
      <nav aria-label="Reports" className="mb-5 flex flex-wrap gap-1 border-b border-line">
        {allowed.map((k) => <Link key={k} href={`/admin/reports?r=${k}`} aria-current={k === key ? "page" : undefined}
          className={cn("border-b-2 px-3 py-2.5", k === key ? "border-pine font-medium text-pine-deep" : "border-transparent text-ink-soft hover:text-ink")}>{REPORTS[k].title}</Link>)}
      </nav>
      <form action="/admin/reports" className="mb-5 flex flex-wrap items-end gap-3">
        <input type="hidden" name="r" value={key} />
        {def.filter === "period" ? <>
          <label><span className="block text-xs text-ink-faint">From</span><input type="date" name="from" defaultValue={from} max={today} className={box} /></label>
          <label><span className="block text-xs text-ink-faint">To</span><input type="date" name="to" defaultValue={to} max={today} className={box} /></label>
        </> : def.filter === "day" ? <label><span className="block text-xs text-ink-faint">Day</span><input type="date" name="to" defaultValue={to} max={today} className={box} /></label>
          : <label><span className="block text-xs text-ink-faint">Expiring within (days)</span><input type="number" name="days" min={0} max={730} defaultValue={days} className={`${box} w-28`} /></label>}
        {def.store ? <label><span className="block text-xs text-ink-faint">Store</span><select name="store" defaultValue={store ?? ""} className={box}>
          {all ? <option value="">All stores</option> : null}{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label> : null}
        <button className="rounded-control border border-line-strong px-3 py-1.5">Show</button>
        {rows.length ? <a href={`/admin/reports/export?${qs}`} className="ml-auto rounded-control bg-pine px-3 py-1.5 font-medium text-white">Download CSV</a> : null}
      </form>
      <Panel title={def.title} aside={<span className="text-sm text-ink-faint">{def.filter === "period" ? (from === to ? to : `${from} to ${to}`) : def.filter === "day" ? to : `next ${days} days`}</span>} flush>
        {blocked ? <p className="px-5 py-4 text-ink-soft">You aren&apos;t assigned to a store.</p> : <ReportTable cols={cols} rows={rows} totals={key !== "stock" && key !== "expiry" ? true : seesCost(ctx)} />}
      </Panel>
      {def.filter === "days" || key === "stock" ? <p className="mt-3 text-sm text-ink-faint">Open a batch from the Expiry report to see every movement it has had.</p> : null}
    </>
  );
}
