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
  address: string | null; payment_terms_days: number | null; is_active: boolean; notes: string | null; payable: number; advance: number;
};
export async function listVendors(tenantId: string): Promise<Vendor[]> {
  const db = serviceClient();
  const [v, b] = await Promise.all([
    db.from("vendors").select("id, vendor_code, name, pan_vat_no, contact_person, phone, email, address, payment_terms_days, is_active, notes").eq("tenant_id", tenantId).order("name"),
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
