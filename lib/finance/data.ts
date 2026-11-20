import "server-only";
import { serviceClient } from "@/lib/supabase/service";

// Finance reads (B8a). Every figure comes from the journal or the documents via SQL functions.

const rows = <T,>(r: { data: unknown; error: { message: string } | null }, what: string): T[] => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r.data ?? []) as T[];
};
const one = <T,>(r: { data: unknown; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
};

export const EXPENSE_CATEGORIES = [
  ["rent", "Rent"], ["electricity", "Electricity"], ["water", "Water"], ["internet", "Internet and phone"], ["salary", "Salaries"],
  ["maintenance", "Maintenance"], ["marketing", "Marketing"], ["licenses", "Licences and fees"], ["transport", "Transport"],
  ["cleaning", "Cleaning"], ["medical_waste", "Medical waste disposal"], ["other", "Other"],
] as const;

export type EntryRow = { id: string; no: string; label: string; amount: number; cash: number; online: number; channel: string | null; at: string; by: string; note: string | null; store: string | null; reversed: boolean };

async function reversedSet(postings: string[]) {
  if (!postings.length) return new Set<string>();
  const r = rows<{ reverses_posting_id: string }>(await serviceClient().from("postings").select("reverses_posting_id").in("reverses_posting_id", postings), "reversals");
  return new Set(r.map((x) => x.reverses_posting_id));
}
async function names(tenantId: string, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const r = rows<{ id: string; display_name: string }>(await serviceClient().from("tenant_members").select("id, display_name").eq("tenant_id", tenantId).in("id", ids), "members");
  return new Map(r.map((m) => [m.id, m.display_name]));
}

export async function listExpenses(tenantId: string): Promise<EntryRow[]> {
  const db = serviceClient();
  const e = rows<{ id: string; expense_no: string; category: string; amount: number; cash_amount: number; online_amount: number; online_channel: string | null; recorded_at: string; recorded_by: string; note: string | null; store_id: string | null; posting_id: string }>(
    await db.from("expenses").select("id, expense_no, category, amount, cash_amount, online_amount, online_channel, recorded_at, recorded_by, note, store_id, posting_id").eq("tenant_id", tenantId).order("recorded_at", { ascending: false }).limit(60), "expenses");
  const [rev, who, st] = await Promise.all([
    reversedSet(e.map((x) => x.posting_id)), names(tenantId, [...new Set(e.map((x) => x.recorded_by))]),
    db.from("stores").select("id, name").eq("tenant_id", tenantId),
  ]);
  const stores = rows<{ id: string; name: string }>(st, "stores");
  return e.map((x) => ({
    id: x.id, no: x.expense_no, label: EXPENSE_CATEGORIES.find(([k]) => k === x.category)?.[1] ?? x.category, amount: Number(x.amount), cash: Number(x.cash_amount),
    online: Number(x.online_amount), channel: x.online_channel, at: x.recorded_at, by: who.get(x.recorded_by) ?? "", note: x.note,
    store: stores.find((s) => s.id === x.store_id)?.name ?? null, reversed: rev.has(x.posting_id),
  }));
}

export async function listOtherIncome(tenantId: string): Promise<EntryRow[]> {
  const i = rows<{ id: string; income_no: string; description: string; amount: number; cash_amount: number; online_amount: number; online_channel: string | null; recorded_at: string; recorded_by: string; posting_id: string }>(
    await serviceClient().from("other_income").select("id, income_no, description, amount, cash_amount, online_amount, online_channel, recorded_at, recorded_by, posting_id").eq("tenant_id", tenantId).order("recorded_at", { ascending: false }).limit(30), "income");
  const [rev, who] = await Promise.all([reversedSet(i.map((x) => x.posting_id)), names(tenantId, [...new Set(i.map((x) => x.recorded_by))])]);
  return i.map((x) => ({ id: x.id, no: x.income_no, label: x.description, amount: Number(x.amount), cash: Number(x.cash_amount), online: Number(x.online_amount),
    channel: x.online_channel, at: x.recorded_at, by: who.get(x.recorded_by) ?? "", note: null, store: null, reversed: rev.has(x.posting_id) }));
}

export async function getFinanceOpening(tenantId: string) {
  const { data } = await serviceClient().from("finance_openings").select("cash_amount, bank_amount, as_of").eq("tenant_id", tenantId).maybeSingle();
  return data ? { cash: Number(data.cash_amount), bank: Number(data.bank_amount), as_of: data.as_of as string } : null;
}

type Bal = { opening: number; closing: number };
export type FinanceReport = {
  balances: Record<"CASH" | "BANK" | "AR_PATIENTS" | "INVENTORY" | "INVENTORY_IN_TRANSIT" | "VENDOR_ADVANCES" | "TAX_RECEIVABLE" | "AP_VENDORS" | "TAX_PAYABLE", Bal>;
  revenue_services: number; revenue_pharmacy: number; other_income: number; cogs: number; inventory_loss: number; inventory_gain: number; expenses: number;
  expenses_by_category: { code: string; name: string; amount: number }[];
  money: { kind: string; cash_in: number; cash_out: number; bank_in: number; bank_out: number }[];
  online_by_channel: Record<string, number>;
};
export async function financeReport(tenantId: string, from: string, to: string): Promise<FinanceReport> {
  return one<FinanceReport>(await serviceClient().rpc("finance_report", { p_tenant: tenantId, p_from: from, p_to: to }), "finance report");
}

export type ProfitLoss = { revenue_services: number; revenue_pharmacy: number; revenue: number; cogs: number; gross_profit: number; inventory_loss: number; inventory_gain: number; expenses: number; rounding: number; other_income: number; net_profit: number };
export async function profitAndLoss(tenantId: string, storeId: string | null, from: string, to: string): Promise<ProfitLoss> {
  return one<ProfitLoss>(await serviceClient().rpc("profit_and_loss", { p_tenant: tenantId, p_store: storeId, p_from: from, p_to: to }), "profit and loss");
}

export type DailySummary = { bills: number; voided: number; sales: number; returns: number; collected: number; refunded: number; dues_change: number; expenses: number; cash_close: number; bank_close: number };
export async function dailySummary(tenantId: string, day: string): Promise<DailySummary> {
  return one<DailySummary>(await serviceClient().rpc("daily_summary", { p_tenant: tenantId, p_day: day }), "daily summary");
}

export async function lastFinanceCheck(tenantId: string) {
  const { data } = await serviceClient().from("finance_checks").select("ran_at, mismatches, checks").eq("tenant_id", tenantId).order("ran_at", { ascending: false }).limit(1).maybeSingle();
  return data as { ran_at: string; mismatches: number; checks: { check: string; documents: number; journal: number; ok: boolean }[] } | null;
}
