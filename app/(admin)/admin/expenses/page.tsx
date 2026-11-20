import { randomUUID } from "node:crypto";
import { requireTenant, can } from "@/lib/auth/context";
import { EXPENSE_CATEGORIES, listExpenses, listOtherIncome, type EntryRow } from "@/lib/finance/data";
import { listStores } from "@/lib/inventory/data";
import { recordExpense, recordIncome } from "@/app/actions/finance";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { ReverseEntry } from "@/components/finance/reverse-entry";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const metadata = { title: "Expenses" };
export const dynamic = "force-dynamic";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const CHANNELS = [["esewa", "eSewa"], ["khalti", "Khalti"], ["fonepay", "Fonepay"], ["bank_transfer", "Bank transfer"], ["card", "Card"], ["other", "Other"]] as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" });

function PaidBy() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="block"><span className={label}>Cash</span><input name="cash" type="number" min={0} step="0.01" className={field} /></label>
      <label className="block"><span className={label}>Online</span><input name="online" type="number" min={0} step="0.01" className={field} /></label>
      <label className="block"><span className={label}>Online by</span><select name="channel" className={field}><option value="">—</option>{CHANNELS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
    </div>
  );
}

function Entries({ rows, kind, canCorrect }: { rows: EntryRow[]; kind: "expense" | "other_income"; canCorrect: boolean }) {
  return (
    <ul className="divide-y divide-line">{rows.map((e) => (
      <li key={e.id} className={cn("grid gap-x-4 gap-y-1 px-5 py-3 sm:grid-cols-[1fr_auto]", e.reversed && "text-ink-faint")}>
        <div>
          <div className={cn("font-medium", e.reversed && "line-through")}>{e.no} {e.label}{e.store ? <span className="text-sm font-normal text-ink-soft">, {e.store}</span> : null}</div>
          <div className="text-sm text-ink-soft">{when(e.at)}, {e.by}{e.note ? `: ${e.note}` : ""}{e.reversed ? " (cancelled)" : ""}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={cn("tabular-nums", e.reversed && "line-through")}>{npr(e.amount)}<span className="ml-1 text-xs text-ink-faint">{[e.cash ? "cash" : null, e.online ? e.channel : null].filter(Boolean).join(" + ")}</span></span>
          {canCorrect && !e.reversed ? <ReverseEntry kind={kind} id={e.id} no={e.no} /> : null}
        </div>
      </li>))}</ul>
  );
}

// Expenses and other income (W-17 §1–3). Recorded as of now; a mistake is cancelled (the
// original stays visible) and the right one recorded again.
export default async function Expenses() {
  const ctx = await requireTenant({ operation: "admin.area", permission: "add_expenses", allowPendingTenant: true, next: "/admin/expenses" });
  const [expenses, income, { stores }] = await Promise.all([listExpenses(ctx.tenantId), listOtherIncome(ctx.tenantId), listStores(ctx.tenantId)]);
  const manage = can(ctx, "manage_expenses");
  const live = expenses.filter((e) => !e.reversed);
  return (
    <>
      <PageHeader title="Expenses" subtitle={`Running costs, recorded as they're paid. ${live.length ? `${npr(live.reduce((s, e) => s + e.amount, 0))} across the last ${live.length} shown.` : ""}`} />
      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <div className="space-y-6">
          <Panel title="Recent expenses" flush>
            {expenses.length ? <Entries rows={expenses} kind="expense" canCorrect={manage} /> : <p className="px-5 py-4 text-ink-soft">No expenses yet.</p>}
          </Panel>
          {manage ? <Panel title="Other income" flush>
            {income.length ? <Entries rows={income} kind="other_income" canCorrect={manage} /> : <p className="px-5 py-4 text-ink-soft">No other income yet. This is money that isn&apos;t from bills, like interest or selling scrap.</p>}
          </Panel> : null}
        </div>
        <div className="space-y-6">
          <Panel title="Record an expense">
            <ActionForm action={recordExpense} submitLabel="Record expense">
              <input type="hidden" name="key" value={randomUUID()} />
              <label className="block"><span className={label}>Category</span>
                <select name="category" required className={field}>{EXPENSE_CATEGORIES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
              <PaidBy />
              <label className="block"><span className={label}>For a store (optional)</span>
                <select name="store_id" className={field}><option value="">The whole clinic</option>{stores.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
              <label className="block"><span className={label}>Note</span><input name="note" maxLength={300} className={field} placeholder="e.g. Kartik rent, receipt 1452" /></label>
            </ActionForm>
          </Panel>
          {manage ? <Panel title="Record other income">
            <ActionForm action={recordIncome} submitLabel="Record income">
              <input type="hidden" name="key" value={randomUUID()} />
              <label className="block"><span className={label}>What it was</span><input name="description" required minLength={3} maxLength={200} className={field} placeholder="e.g. Bank interest" /></label>
              <PaidBy />
            </ActionForm>
          </Panel> : null}
        </div>
      </div>
    </>
  );
}
