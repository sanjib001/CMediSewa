import "server-only";
import { serviceClient } from "@/lib/supabase/service";
import { listStores } from "@/lib/inventory/data";
import { can, type TenantContext } from "@/lib/auth/context";

// Report definitions (B8b), shared by the Reports page and the CSV export. Every report is a
// read-only SQL function over the stock ledger, the documents or the journal.

export type Col = { key: string; label: string; kind: "text" | "qty" | "money" | "date" | "time"; cost?: boolean; link?: (r: Row) => string | null };
export type Row = Record<string, string | number | null>;
export type ReportKey = "stock" | "expiry" | "sales" | "items" | "purchases" | "cashbook";
type Def = { title: string; about: string; anyOf: string[]; filter: "period" | "day" | "days"; store: boolean; cols: Col[] };

export const KIND: Record<string, string> = {
  payment: "Patient payment or refund", purchase_invoice: "Purchase bill", vendor_payment: "Vendor payment", purchase_return: "Vendor refund",
  expense: "Expense", other_income: "Other income", finance_opening: "Opening balance", invoice: "Bill",
};

export const REPORTS: Record<ReportKey, Def> = {
  stock: {
    title: "Stock movement", about: "Per item, in base units: opening + received − sold (net of returns) − other out = closing.",
    anyOf: ["view_stock_reports"], filter: "period", store: true,
    cols: [{ key: "item_code", label: "Code", kind: "text" }, { key: "item", label: "Item", kind: "text" }, { key: "unit", label: "Unit", kind: "text" },
      { key: "opening_qty", label: "Opening", kind: "qty" }, { key: "received_qty", label: "Received", kind: "qty" }, { key: "sold_qty", label: "Sold", kind: "qty" },
      { key: "other_out_qty", label: "Other out", kind: "qty" }, { key: "closing_qty", label: "Closing", kind: "qty" },
      { key: "closing_value", label: "Closing value", kind: "money", cost: true }, { key: "sold_cost", label: "Cost of sold", kind: "money", cost: true }],
  },
  expiry: {
    title: "Expiry", about: "Batches on hand that are expired or expire within the window, soonest first.",
    anyOf: ["view_stock_reports"], filter: "days", store: true,
    cols: [{ key: "expiry_date", label: "Expires", kind: "date" }, { key: "days_left", label: "Days left", kind: "qty" }, { key: "item", label: "Item", kind: "text" },
      { key: "batch_no", label: "Batch", kind: "text", link: (r) => `/admin/reports/batch/${r.batch_id}` }, { key: "store", label: "Store", kind: "text" },
      { key: "qty", label: "On hand", kind: "qty" }, { key: "unit", label: "Unit", kind: "text" }, { key: "value", label: "Value", kind: "money", cost: true }, { key: "status", label: "Status", kind: "text" }],
  },
  sales: {
    title: "Sales register", about: "Every bill in the period with returns, payments and what is still owed.",
    anyOf: ["view_reports"], filter: "period", store: true,
    cols: [{ key: "invoice_no", label: "Bill", kind: "text", link: (r) => `/employee/pharmacy/bills/${r.invoice_id}` }, { key: "issued_at", label: "Time", kind: "time" },
      { key: "customer", label: "Customer", kind: "text" }, { key: "store", label: "Store", kind: "text" }, { key: "total", label: "Total", kind: "money" },
      { key: "returned", label: "Returned", kind: "money" }, { key: "paid", label: "Paid", kind: "money" }, { key: "outstanding", label: "Owed", kind: "money" },
      { key: "status", label: "Status", kind: "text" }, { key: "issued_by", label: "By", kind: "text" }],
  },
  items: {
    title: "Item sales", about: "What sold per item (void bills excluded, returns subtracted): quantity, revenue before VAT, cost and margin.",
    anyOf: ["view_reports"], filter: "period", store: true,
    cols: [{ key: "item", label: "Item", kind: "text" }, { key: "qty", label: "Qty", kind: "qty" }, { key: "unit", label: "Unit", kind: "text" },
      { key: "revenue", label: "Revenue", kind: "money" }, { key: "cost", label: "Cost", kind: "money", cost: true }, { key: "margin", label: "Margin", kind: "money", cost: true },
      { key: "bills", label: "Bills", kind: "qty" }],
  },
  purchases: {
    title: "Purchase register", about: "Vendor bills entered in the period, with what was paid, on credit and still owed.",
    anyOf: ["manage_purchases", "view_financial_reports"], filter: "period", store: false,
    cols: [{ key: "purchase_no", label: "Our no.", kind: "text", link: (r) => `/admin/purchases/${r.purchase_id}` }, { key: "posted_at", label: "Entered", kind: "time" },
      { key: "vendor", label: "Vendor", kind: "text" }, { key: "vendor_invoice_no", label: "Their bill", kind: "text" }, { key: "vendor_invoice_date", label: "Bill date", kind: "date" },
      { key: "store", label: "Store", kind: "text" }, { key: "total", label: "Total", kind: "money" }, { key: "tax", label: "VAT", kind: "money" },
      { key: "paid", label: "Paid", kind: "money" }, { key: "credit", label: "On credit", kind: "money" }, { key: "outstanding", label: "Owed", kind: "money" }, { key: "status", label: "Status", kind: "text" }],
  },
  cashbook: {
    title: "Cash book", about: "Every cash entry of the day with its cause and the running cash balance.",
    anyOf: ["view_financial_reports"], filter: "day", store: false,
    cols: [{ key: "occurred_at", label: "Time", kind: "time" }, { key: "kind_label", label: "What", kind: "text" }, { key: "memo", label: "Reference", kind: "text" },
      { key: "cash_in", label: "In", kind: "money" }, { key: "cash_out", label: "Out", kind: "money" }, { key: "balance", label: "Balance", kind: "money" }],
  },
};

const has = (ctx: TenantContext, k: string) => can(ctx, k as Parameters<typeof can>[1]);
export const allowedReports = (ctx: TenantContext) => (Object.keys(REPORTS) as ReportKey[]).filter((k) => REPORTS[k].anyOf.some((p) => has(ctx, p)));
export const seesCost = (ctx: TenantContext) => has(ctx, "view_cost_prices");

/** Stores the member may report on; `all` when they may see every store at once. */
export async function reportStores(ctx: TenantContext) {
  const { stores } = await listStores(ctx.tenantId);
  const db = serviceClient();
  const out: { id: string; name: string }[] = [];
  for (const s of stores) {
    const { data } = await db.rpc("store_access", { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_store: s.id });
    if (data) out.push({ id: s.id, name: s.name });
  }
  return { stores: out, all: out.length === stores.length };
}

export type Params = { from: string; to: string; days: number; store: string | null };
export async function runReport(tenantId: string, key: ReportKey, p: Params): Promise<Row[]> {
  const db = serviceClient();
  const r = key === "stock" ? await db.rpc("stock_report", { p_tenant: tenantId, p_store: p.store, p_from: p.from, p_to: p.to })
    : key === "expiry" ? await db.rpc("expiry_report", { p_tenant: tenantId, p_store: p.store, p_days: p.days })
    : key === "sales" ? await db.rpc("sales_register", { p_tenant: tenantId, p_store: p.store, p_from: p.from, p_to: p.to })
    : key === "items" ? await db.rpc("item_sales", { p_tenant: tenantId, p_store: p.store, p_from: p.from, p_to: p.to })
    : key === "purchases" ? await db.rpc("purchase_register", { p_tenant: tenantId, p_from: p.from, p_to: p.to })
    : await db.rpc("cash_book", { p_tenant: tenantId, p_day: p.to });
  if (r.error) throw new Error(`${key} report: ${r.error.message}`);
  const rows = (r.data ?? []) as Row[];
  return key === "cashbook" ? rows.map((x) => ({ ...x, kind_label: KIND[String(x.kind)] ?? String(x.kind) })) : rows;
}

export function columnsFor(key: ReportKey, cost: boolean) { return REPORTS[key].cols.filter((c) => cost || !c.cost); }

export type BatchInfo = { id: string; batch_no: string; expiry_date: string | null; status: string; item: string; unit: string; vendor: string | null };
export async function batchInfo(tenantId: string, id: string): Promise<BatchInfo | null> {
  const db = serviceClient();
  const { data: b } = await db.from("item_batches").select("id, batch_no, expiry_date, status, item_id, vendor_id").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (!b) return null;
  const [it, un, v] = await Promise.all([
    db.from("inventory_items").select("name").eq("id", b.item_id).single(),
    db.from("item_units").select("name").eq("item_id", b.item_id).eq("is_base", true).maybeSingle(),
    b.vendor_id ? db.from("vendors").select("name").eq("id", b.vendor_id).single() : Promise.resolve({ data: null }),
  ]);
  return { id: b.id, batch_no: b.batch_no, expiry_date: b.expiry_date, status: b.status, item: (it.data as { name: string } | null)?.name ?? "",
    unit: (un.data as { name: string } | null)?.name ?? "", vendor: (v.data as { name: string } | null)?.name ?? null };
}
export async function batchHistory(tenantId: string, id: string): Promise<Row[]> {
  const r = await serviceClient().rpc("batch_history", { p_tenant: tenantId, p_batch: id });
  if (r.error) throw new Error(`batch history: ${r.error.message}`);
  return (r.data ?? []) as Row[];
}

/** CSV with formula-injection guarding (a cell starting with = + - @ is prefixed with '). */
export function toCsv(cols: Col[], rows: Row[]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map((c) => cell(c.label)).join(","), ...rows.map((r) => cols.map((c) => cell(r[c.key])).join(","))].join("\r\n") + "\r\n";
}
