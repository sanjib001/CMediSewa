import "server-only";
import { serviceClient } from "@/lib/supabase/service";

// Read side of purchasing (B6a). The payable comes from the journal (vendor_balances), never
// from a stored column; per-bill outstanding comes from purchase_outstanding().

function rows<T>(r: { data: unknown; error: { message: string } | null }, what: string): T[] {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r.data ?? []) as T[];
}

export type Vendor = {
  id: string; vendor_code: string; name: string; pan_vat_no: string | null; contact_person: string | null; phone: string | null; email: string | null;
  address: string | null; payment_terms_days: number | null; lead_time_days: number | null; is_active: boolean; notes: string | null; payable: number; advance: number;
};
export async function listVendors(tenantId: string): Promise<Vendor[]> {
  const db = serviceClient();
  const [v, b] = await Promise.all([
    db.from("vendors").select("id, vendor_code, name, pan_vat_no, contact_person, phone, email, address, payment_terms_days, lead_time_days, is_active, notes").eq("tenant_id", tenantId).order("name"),
    db.rpc("vendor_balances", { p_tenant: tenantId }),
  ]);
  const bal = rows<{ vendor_id: string; payable: number; advance: number }>(b, "vendor balances");
  return rows<Omit<Vendor, "payable" | "advance">>(v, "vendors").map((x) => {
    const k = bal.find((y) => y.vendor_id === x.id);
    return { ...x, payable: Number(k?.payable ?? 0), advance: Number(k?.advance ?? 0) };
  });
}

export type PurchaseRow = {
  id: string; purchase_no: string; kind: string; vendor_id: string; vendor_invoice_no: string; vendor_invoice_date: string; status: string;
  total: number; paid_cash: number; paid_online: number; credit_amount: number; outstanding: number; posted_at: string; received_store_id: string | null;
};
export async function listPurchases(tenantId: string, vendorId?: string): Promise<PurchaseRow[]> {
  const db = serviceClient();
  let q = db.from("purchase_invoices").select("id, purchase_no, kind, vendor_id, vendor_invoice_no, vendor_invoice_date, status, total, paid_cash, paid_online, credit_amount, posted_at, received_store_id")
    .eq("tenant_id", tenantId).order("vendor_invoice_date", { ascending: false }).order("posted_at", { ascending: false }).limit(200);
  if (vendorId) q = q.eq("vendor_id", vendorId);
  const list = rows<Omit<PurchaseRow, "outstanding">>(await q, "purchases");
  if (!list.length) return [];
  const { data: al } = await db.from("vendor_payment_allocations").select("purchase_invoice_id, amount").eq("tenant_id", tenantId).in("purchase_invoice_id", list.map((p) => p.id));
  const paid = (id: string) => ((al ?? []) as { purchase_invoice_id: string; amount: number }[]).filter((a) => a.purchase_invoice_id === id).reduce((s, a) => s + Number(a.amount), 0);
  return list.map((p) => ({ ...p, total: Number(p.total), paid_cash: Number(p.paid_cash), paid_online: Number(p.paid_online), credit_amount: Number(p.credit_amount),
    outstanding: p.status === "void" ? 0 : Math.round((Number(p.credit_amount) - paid(p.id)) * 100) / 100 }));
}

export async function getPurchase(tenantId: string, id: string) {
  const db = serviceClient();
  const { data: h } = await db.from("purchase_invoices").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (!h) return null;
  const head = h as Record<string, unknown> & { vendor_id: string; received_store_id: string | null };
  const [l, v, s, al] = await Promise.all([
    db.from("purchase_invoice_lines").select("line_no, item_id, unit_id, qty, free_qty, unit_cost, discount_pct, tax_rate, tax_amount, line_net, batch_no, expiry_date, mrp, batch_id").eq("purchase_id", id).order("line_no"),
    db.from("vendors").select("name, vendor_code").eq("id", head.vendor_id).single(),
    head.received_store_id ? db.from("stores").select("name").eq("id", head.received_store_id).single() : Promise.resolve({ data: null }),
    db.from("vendor_payment_allocations").select("amount, vendor_payment_id").eq("purchase_invoice_id", id),
  ]);
  const lines = rows<{ line_no: number; item_id: string; unit_id: string; qty: number; free_qty: number; unit_cost: number; discount_pct: number; tax_rate: number; tax_amount: number; line_net: number; batch_no: string; expiry_date: string | null; mrp: number | null; batch_id: string }>(l, "lines");
  const ids = [...new Set(lines.map((x) => x.item_id))];
  const [it, un, lots] = await Promise.all([
    ids.length ? db.from("inventory_items").select("id, name").in("id", ids) : Promise.resolve({ data: [] }),
    ids.length ? db.from("item_units").select("id, name").in("item_id", ids) : Promise.resolve({ data: [] }),
    lines.length ? db.from("item_batches").select("id, unit_cost_base").in("id", lines.map((x) => x.batch_id)) : Promise.resolve({ data: [] }),
  ]);
  const nm = <T extends { id: string }>(list: unknown, id: string) => ((list ?? []) as T[]).find((x) => x.id === id);
  const paid = ((al.data ?? []) as { amount: number }[]).reduce((sum, a) => sum + Number(a.amount), 0);
  return {
    head, vendor: v.data as { name: string; vendor_code: string } | null, store: (s.data as { name: string } | null)?.name ?? null,
    lines: lines.map((x) => ({ ...x, item: nm<{ id: string; name: string }>(it.data, x.item_id)?.name ?? "", unit: nm<{ id: string; name: string }>(un.data, x.unit_id)?.name ?? "",
      lot_cost_base: Number(nm<{ id: string; unit_cost_base: number }>(lots.data, x.batch_id)?.unit_cost_base ?? 0) })),
    paidLater: paid, outstanding: head.status === "void" ? 0 : Number(head.credit_amount) - paid,
  };
}

export type StatementLine = { at: string; doc: string; kind: string; debit: number; credit: number; balance: number; memo: string | null };
/** A vendor's account straight from the journal (AP_VENDORS + VENDOR_ADVANCES), oldest first. */
export async function vendorStatement(tenantId: string, vendorId: string): Promise<StatementLine[]> {
  const { data, error } = await serviceClient().from("ledger_entries").select("occurred_at, doc_type, account_code, debit, credit, memo, posting_id")
    .eq("tenant_id", tenantId).eq("vendor_id", vendorId).in("account_code", ["AP_VENDORS", "VENDOR_ADVANCES"]).order("occurred_at").order("id").limit(1000);
  if (error) throw new Error(`statement: ${error.message}`);
  let bal = 0;
  return ((data ?? []) as { occurred_at: string; doc_type: string; account_code: string; debit: number; credit: number; memo: string | null }[]).map((e) => {
    // owed to the vendor goes UP with an AP credit and DOWN with an AP debit or an advance.
    const owed = Number(e.credit) - Number(e.debit);
    bal = Math.round((bal + owed) * 100) / 100;
    return { at: e.occurred_at, doc: e.memo ?? "", kind: e.doc_type, debit: Number(e.debit), credit: Number(e.credit), balance: bal, memo: e.account_code === "VENDOR_ADVANCES" ? "advance" : null };
  });
}

export type PaymentRow = { id: string; payment_no: string; amount: number; cash_amount: number; online_amount: number; online_channel: string | null; reference: string | null; paid_at: string };
export async function listVendorPayments(tenantId: string, vendorId: string): Promise<PaymentRow[]> {
  const { data } = await serviceClient().from("vendor_payments").select("id, payment_no, amount, cash_amount, online_amount, online_channel, reference, paid_at")
    .eq("tenant_id", tenantId).eq("vendor_id", vendorId).order("paid_at", { ascending: false }).limit(100);
  return ((data ?? []) as PaymentRow[]).map((p) => ({ ...p, amount: Number(p.amount), cash_amount: Number(p.cash_amount), online_amount: Number(p.online_amount) }));
}

// ── B6b: orders, returns, payable check ──────────────────────────────────────
export type OrderRow = { id: string; po_no: string; vendor_id: string; deliver_to_store_id: string; status: string; expected_date: string | null; created_at: string; note: string | null; created_by: string; approved_at: string | null };
export async function listOrders(tenantId: string): Promise<OrderRow[]> {
  return rows<OrderRow>(await serviceClient().from("purchase_orders").select("id, po_no, vendor_id, deliver_to_store_id, status, expected_date, created_at, note, created_by, approved_at")
    .eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(100), "orders");
}
export async function getOrder(tenantId: string, id: string) {
  const db = serviceClient();
  const { data: po } = await db.from("purchase_orders").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (!po) return null;
  const head = po as OrderRow & { closed_reason: string | null };
  const lines = rows<{ id: string; line_no: number; item_id: string; unit_id: string; qty: number; factor_snapshot: number; base_qty: number; expected_unit_cost: number | null }>(
    await db.from("purchase_order_lines").select("id, line_no, item_id, unit_id, qty, factor_snapshot, base_qty, expected_unit_cost").eq("po_id", id).order("line_no"), "order lines");
  const ids = [...new Set(lines.map((l) => l.item_id))];
  const [it, un, ...rec] = await Promise.all([
    ids.length ? db.from("inventory_items").select("id, name").in("id", ids) : Promise.resolve({ data: [] }),
    ids.length ? db.from("item_units").select("id, name").in("item_id", ids) : Promise.resolve({ data: [] }),
    ...lines.map((l) => db.rpc("po_line_received", { p_line: l.id })),
  ]);
  return {
    head,
    lines: lines.map((l, i) => {
      const received = Number((rec[i] as { data: unknown }).data ?? 0);
      return { ...l, qty: Number(l.qty), base_qty: Number(l.base_qty), factor: Number(l.factor_snapshot), received_base: received,
        remaining_units: Math.max(0, Math.round(((Number(l.base_qty) - received) / Number(l.factor_snapshot)) * 1000) / 1000),
        item: ((it.data ?? []) as { id: string; name: string }[]).find((x) => x.id === l.item_id)?.name ?? "",
        unit: ((un.data ?? []) as { id: string; name: string }[]).find((x) => x.id === l.unit_id)?.name ?? "" };
    }),
  };
}

export type ReturnRow = { id: string; return_no: string; vendor_id: string; settlement: string; total: number; posted_at: string; purchase_invoice_id: string | null };
export async function listReturns(tenantId: string): Promise<ReturnRow[]> {
  return rows<ReturnRow>(await serviceClient().from("purchase_returns").select("id, return_no, vendor_id, settlement, total, posted_at, purchase_invoice_id")
    .eq("tenant_id", tenantId).order("posted_at", { ascending: false }).limit(100), "returns").map((r) => ({ ...r, total: Number(r.total) }));
}

export type ReturnableLot = { batch_id: string; item: string; batch_no: string; expiry_date: string | null; status: string; qty: number; unit: string; cost: number; on_bill: string | null };
/** Lots in a store bought from this vendor (optionally only those on one bill), with stock on hand. */
export async function returnableLots(tenantId: string, vendorId: string, storeId: string, invoiceId?: string | null): Promise<ReturnableLot[]> {
  const db = serviceClient();
  const lq = db.from("item_batches").select("id, item_id, batch_no, expiry_date, status, unit_cost_base, purchase_invoice_line_id").eq("tenant_id", tenantId).eq("vendor_id", vendorId);
  const lots = rows<{ id: string; item_id: string; batch_no: string; expiry_date: string | null; status: string; unit_cost_base: number; purchase_invoice_line_id: string | null }>(await lq, "lots");
  if (!lots.length) return [];
  let keep = lots;
  if (invoiceId) {
    const { data: pl } = await db.from("purchase_invoice_lines").select("id").eq("purchase_id", invoiceId);
    const set = new Set(((pl ?? []) as { id: string }[]).map((x) => x.id));
    keep = lots.filter((l) => l.purchase_invoice_line_id && set.has(l.purchase_invoice_line_id));
  }
  const [bal, it, un] = await Promise.all([
    db.from("stock_balances").select("batch_id, qty_on_hand").eq("tenant_id", tenantId).eq("store_id", storeId).in("batch_id", keep.map((l) => l.id)),
    db.from("inventory_items").select("id, name").in("id", [...new Set(keep.map((l) => l.item_id))]),
    db.from("item_units").select("item_id, name").eq("is_base", true).in("item_id", [...new Set(keep.map((l) => l.item_id))]),
  ]);
  const q = (id: string) => Number(((bal.data ?? []) as { batch_id: string; qty_on_hand: number }[]).find((b) => b.batch_id === id)?.qty_on_hand ?? 0);
  return keep.filter((l) => q(l.id) > 0).map((l) => ({
    batch_id: l.id, item: ((it.data ?? []) as { id: string; name: string }[]).find((x) => x.id === l.item_id)?.name ?? "", batch_no: l.batch_no, expiry_date: l.expiry_date,
    status: l.status, qty: q(l.id), unit: ((un.data ?? []) as { item_id: string; name: string }[]).find((x) => x.item_id === l.item_id)?.name ?? "", cost: Number(l.unit_cost_base),
    on_bill: l.purchase_invoice_line_id,
  })).sort((a, b) => a.item.localeCompare(b.item) || (a.expiry_date ?? "9").localeCompare(b.expiry_date ?? "9"));
}

export async function lastPayableCheck(tenantId: string) {
  const { data } = await serviceClient().from("payable_reconciliations").select("ran_at, vendors, mismatches").eq("tenant_id", tenantId).order("ran_at", { ascending: false }).limit(1).maybeSingle();
  return data as { ran_at: string; vendors: number; mismatches: number } | null;
}

// ── M-46 (D-144): purchase plan and supplier performance ─────────────────────
export type PlanRow = {
  store_id: string; store_name: string; item_id: string; item_name: string; vendor_id: string | null; vendor_name: string | null;
  on_hand: number; on_order: number; used: number; per_day: number; days_left: number | null; lead_days: number; reorder_level: number | null;
  suggested_base: number; purchase_unit_id: string | null; purchase_unit: string; unit_factor: number; suggested_units: number;
  last_unit_cost_base: number | null; est_cost: number; reason: "level" | "sales";
};
/** What each receiving store should order, from its use over the last `days` and each vendor's delivery time. */
export async function purchasePlan(tenantId: string, days = 30): Promise<PlanRow[]> {
  const r = await serviceClient().rpc("purchase_plan", { p_tenant: tenantId, p_store: null, p_days: days });
  const NUM = ["on_hand", "on_order", "used", "per_day", "days_left", "lead_days", "reorder_level", "suggested_base", "unit_factor", "suggested_units", "last_unit_cost_base", "est_cost"] as const;
  return rows<Record<string, unknown>>(r, "purchase plan").map((x) => {
    const o = { ...x } as Record<string, unknown>;
    for (const k of NUM) o[k] = o[k] === null || o[k] === undefined ? null : Number(o[k]);
    return o as unknown as PlanRow;
  });
}

export type VendorPerformance = {
  orders: number; fill_rate: number | null; on_time_rate: number | null; delivery_days: number | null; bills: number; purchased: number; returned: number;
  return_rate: number | null; shelf_life_days: number | null; short_dated_lots: number; price_changes: { item: string; last: number; previous: number; change_pct: number }[];
};
export async function vendorPerformance(tenantId: string, vendorId: string, days = 365): Promise<VendorPerformance> {
  const { data, error } = await serviceClient().rpc("vendor_performance", { p_tenant: tenantId, p_vendor: vendorId, p_days: days });
  if (error) throw new Error(`vendor performance: ${error.message}`);
  const p = data as Record<string, unknown>;
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    orders: Number(p.orders ?? 0), fill_rate: n(p.fill_rate), on_time_rate: n(p.on_time_rate), delivery_days: n(p.delivery_days), bills: Number(p.bills ?? 0),
    purchased: Number(p.purchased ?? 0), returned: Number(p.returned ?? 0), return_rate: n(p.return_rate), shelf_life_days: n(p.shelf_life_days),
    short_dated_lots: Number(p.short_dated_lots ?? 0),
    price_changes: ((p.price_changes ?? []) as { item: string; last: unknown; previous: unknown; change_pct: unknown }[]).map((c) => ({ item: c.item, last: Number(c.last), previous: Number(c.previous), change_pct: Number(c.change_pct) })),
  };
}
