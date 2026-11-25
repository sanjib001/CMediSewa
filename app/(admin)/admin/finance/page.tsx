import { randomUUID } from "node:crypto";
import Link from "next/link";
import { requireTenant, can } from "@/lib/auth/context";
import { dailySummary, financeReport, getFinanceOpening, lastFinanceCheck, profitAndLoss } from "@/lib/finance/data";
import { listStores } from "@/lib/inventory/data";
import { todayIn } from "@/lib/desk/data";
import { postOpening, runFinanceCheck } from "@/app/actions/finance";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const metadata = { title: "Finance" };
export const dynamic = "force-dynamic";

const npr = (n: number) => `${n < 0 ? "−" : ""}Rs. ${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const BALANCES: [string, string][] = [["CASH", "Cash in hand"], ["BANK", "Bank and online"], ["AR_PATIENTS", "Owed by patients"], ["INVENTORY", "Stock at cost"],
  ["INVENTORY_IN_TRANSIT", "Stock in transit"], ["VENDOR_ADVANCES", "Paid ahead to vendors"], ["TAX_RECEIVABLE", "VAT to recover"], ["AP_VENDORS", "Owed to vendors"], ["PATIENT_ADVANCES", "Advances held for patients"], ["TAX_PAYABLE", "VAT to pay"]];
const MONEY: Record<string, string> = {
  payment: "Patients and customers (bills, dues, refunds)", purchase_invoice: "Purchase bills paid at entry", vendor_payment: "Vendor payments",
  purchase_return: "Refunds from vendors", patient_advance: "Patient advances (taken, given back)", expense: "Expenses", other_income: "Other income", finance_opening: "Opening balance",
};
const CHECKS: Record<string, string> = { receivables: "Owed by patients", inventory: "Stock value", cash: "Cash", bank: "Bank and online", advances: "Advances held for patients" };

function Row({ label: l, value, strong, sub }: { label: string; value: number; strong?: boolean; sub?: boolean }) {
  return <div className={cn("flex justify-between gap-4 py-1.5", strong && "border-t border-line pt-2 font-semibold", sub && "pl-4 text-sm text-ink-soft")}><span>{l}</span><span className="tabular-nums">{npr(value)}</span></div>;
}

// Finance (W-17 §4–6): the period's profit and loss, balances at its start and end, money in
// and out by cause, the daily summary, opening balances, and the integrity check.
export default async function Finance({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; store?: string }> }) {
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_finance", allowPendingTenant: true, next: "/admin/finance" });
  const sp = await searchParams;
  const today = todayIn();
  const to = sp.to && DATE.test(sp.to) && sp.to <= today ? sp.to : today;
  const from = sp.from && DATE.test(sp.from) && sp.from <= to && shift(sp.from, 400) >= to ? sp.from : to;
  const { stores } = await listStores(ctx.tenantId);
  const store = stores.find((s) => s.id === sp.store) ?? null;
  const [rep, pl, day, opening, check] = await Promise.all([
    financeReport(ctx.tenantId, from, to), profitAndLoss(ctx.tenantId, store?.id ?? null, from, to),
    from === to ? dailySummary(ctx.tenantId, to) : Promise.resolve(null), getFinanceOpening(ctx.tenantId), lastFinanceCheck(ctx.tenantId),
  ]);
  const month = `${today.slice(0, 8)}01`;
  const q = (f: string, t: string) => `/admin/finance?from=${f}&to=${t}${store ? `&store=${store.id}` : ""}`;
  const chans = Object.entries(rep.online_by_channel).filter(([, v]) => Number(v) !== 0);
  return (
    <>
      <PageHeader title="Finance" subtitle={from === to ? `Business day ${to}` : `${from} to ${to}`} />
      <div className="mb-6 flex flex-wrap items-end gap-3">
        {([["Today", today, today], ["Yesterday", shift(today, -1), shift(today, -1)], ["This month", month, today], ["Last 30 days", shift(today, -29), today]] as [string, string, string][]).map(([t, f, e]) => (
          <Link key={t} href={q(f, e)} className={cn("rounded-control border px-3 py-2", from === f && to === e ? "border-pine bg-pine/5 font-medium" : "border-line-strong")}>{t}</Link>
        ))}
        <form action="/admin/finance" className="flex flex-wrap items-end gap-2">
          <label><span className="block text-xs text-ink-faint">From</span><input type="date" name="from" defaultValue={from} max={today} className="rounded-control border border-line-strong px-2 py-1.5" /></label>
          <label><span className="block text-xs text-ink-faint">To</span><input type="date" name="to" defaultValue={to} max={today} className="rounded-control border border-line-strong px-2 py-1.5" /></label>
          <label><span className="block text-xs text-ink-faint">Profit and loss for</span><select name="store" defaultValue={store?.id ?? ""} className="rounded-control border border-line-strong px-2 py-1.5"><option value="">The whole clinic</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <button className="rounded-control border border-line-strong px-3 py-1.5">Show</button>
        </form>
      </div>

      {day ? (
        <section aria-label="Day at a glance" className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[["Bills", `${day.bills}${day.voided ? ` (${day.voided} void)` : ""}`, npr(Number(day.sales))], ["Collected", npr(Number(day.collected)), [Number(day.refunded) ? `${npr(Number(day.refunded))} refunded` : "no refunds", Number(day.advances_in) || Number(day.advances_used) ? `advances: ${npr(Number(day.advances_in ?? 0))} taken, ${npr(Number(day.advances_used ?? 0))} used${Number(day.advances_refunded) ? `, ${npr(Number(day.advances_refunded))} given back` : ""}` : ""].filter(Boolean).join("; ")],
            ["Expenses", npr(Number(day.expenses)), Number(day.returns) ? `returns ${npr(Number(day.returns))}` : "no returns"], ["Cash at close", npr(Number(day.cash_close)), `bank ${npr(Number(day.bank_close))}`]].map(([t, v, s]) => (
            <div key={t} className="rounded-panel border border-line bg-surface px-4 py-3"><div className="text-sm text-ink-soft">{t}</div><div className="text-xl font-semibold tabular-nums">{v}</div><div className="text-sm text-ink-faint">{s}</div></div>
          ))}
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Panel title={`Profit and loss${store ? `: ${store.name}` : ""}`}>
          <Row label="Services and OPD" value={Number(pl.revenue_services)} sub /><Row label="Pharmacy" value={Number(pl.revenue_pharmacy)} sub />
          <Row label="Revenue" value={Number(pl.revenue)} /><Row label="Cost of medicines sold" value={-Number(pl.cogs)} />
          <Row label="Gross profit" value={Number(pl.gross_profit)} strong />
          <Row label="Stock losses (expiry, damage, shortage)" value={-Number(pl.inventory_loss)} />{Number(pl.inventory_gain) ? <Row label="Stock gains" value={Number(pl.inventory_gain)} /> : null}
          <Row label="Expenses" value={-Number(pl.expenses)} />{store ? null : <Row label="Other income" value={Number(pl.other_income)} />}
          <Row label="Net profit" value={Number(pl.net_profit)} strong />
          {store ? <p className="mt-2 text-sm text-ink-faint">Only what is tagged to this store. Untagged expenses and other income count for the whole clinic.</p> : null}
        </Panel>

        <Panel title="Balances" flush>
          <table className="w-full text-left text-[0.95rem]">
            <thead className="text-sm text-ink-faint"><tr><th className="px-5 py-2 font-medium" /><th className="py-2 text-right font-medium">At the start</th><th className="px-5 py-2 text-right font-medium">At the end</th></tr></thead>
            <tbody className="divide-y divide-line">{BALANCES.filter(([k]) => Number(rep.balances[k as keyof typeof rep.balances].opening) || Number(rep.balances[k as keyof typeof rep.balances].closing) || ["CASH", "BANK", "AR_PATIENTS", "INVENTORY", "AP_VENDORS"].includes(k)).map(([k, t]) => {
              const b = rep.balances[k as keyof typeof rep.balances];
              return <tr key={k}><td className="px-5 py-2">{t}</td><td className="py-2 text-right tabular-nums">{npr(Number(b.opening))}</td><td className="px-5 py-2 text-right tabular-nums">{npr(Number(b.closing))}</td></tr>;
            })}</tbody>
          </table>
        </Panel>

        <Panel title="Money in and out" flush>
          {rep.money.length === 0 ? <p className="px-5 py-4 text-ink-soft">No money moved in this period.</p> : (
            <table className="w-full text-left text-[0.95rem]">
              <thead className="text-sm text-ink-faint"><tr><th className="px-5 py-2 font-medium" /><th className="py-2 text-right font-medium">Cash</th><th className="px-5 py-2 text-right font-medium">Bank and online</th></tr></thead>
              <tbody className="divide-y divide-line">{rep.money.map((m) => (
                <tr key={m.kind}><td className="px-5 py-2">{MONEY[m.kind] ?? m.kind}</td>
                  <td className="py-2 text-right tabular-nums">{npr(Number(m.cash_in) - Number(m.cash_out))}</td><td className="px-5 py-2 text-right tabular-nums">{npr(Number(m.bank_in) - Number(m.bank_out))}</td></tr>))}</tbody>
            </table>
          )}
          {chans.length ? <p className="px-5 py-3 text-sm text-ink-soft">Online by channel: {chans.map(([c, v]) => `${c.replace("_", " ")} ${npr(Number(v))}`).join(", ")}</p> : null}
        </Panel>

        <Panel title="Expenses by category" flush>
          {rep.expenses_by_category.length === 0 ? <p className="px-5 py-4 text-ink-soft">No expenses in this period.</p> : (
            <ul className="divide-y divide-line">{rep.expenses_by_category.map((e) => <li key={e.code} className="flex justify-between px-5 py-2"><span>{e.name}</span><span className="tabular-nums">{npr(Number(e.amount))}</span></li>)}</ul>
          )}
        </Panel>

        <Panel title="Books check" aside={<span className="text-sm text-ink-faint">Runs every night</span>}>
          <p className="mb-3 text-sm text-ink-soft">Cash, bank, what patients owe and stock value, worked out again from every bill, payment, purchase and expense, must equal the accounts.</p>
          {check ? (
            <>
              <p className="mb-2 text-sm">Last checked {new Date(check.ran_at).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu" })}: {check.mismatches ? <span className="font-medium text-alert">{check.mismatches} differ</span> : "everything matches"}.</p>
              {check.mismatches ? <ul className="mb-3 text-sm">{check.checks.filter((c) => !c.ok).map((c) => <li key={c.check} className="text-alert">{CHECKS[c.check] ?? c.check}: documents {npr(Number(c.documents))}, accounts {npr(Number(c.journal))}</li>)}</ul> : null}
            </>
          ) : <p className="mb-2 text-sm">Not checked yet.</p>}
          <ActionForm action={runFinanceCheck} submitLabel="Check now" tone="secondary"><></></ActionForm>
        </Panel>

        {can(ctx, "manage_expenses") ? (
          <Panel title="Opening cash and bank">
            {opening ? <p className="text-ink-soft">Entered as of {opening.as_of}: cash {npr(opening.cash)}, bank {npr(opening.bank)}. This is entered once.</p> : (
              <ActionForm action={postOpening} submitLabel="Record opening balances" confirm="Opening balances are entered once. Continue?">
                <input type="hidden" name="key" value={randomUUID()} />
                <p className="text-sm text-ink-soft">What was in the till and the bank when the clinic started using CMediSewa. Opening stock and vendor balances are entered on their own pages.</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block"><span className={label}>Cash</span><input name="cash" type="number" min={0} step="0.01" className={field} /></label>
                  <label className="block"><span className={label}>Bank and online</span><input name="bank" type="number" min={0} step="0.01" className={field} /></label>
                  <label className="block"><span className={label}>As of</span><input name="as_of" type="date" required max={today} defaultValue={today} className={field} /></label>
                </div>
              </ActionForm>
            )}
          </Panel>
        ) : null}
      </div>
    </>
  );
}
