import "server-only";
import { serviceClient } from "@/lib/supabase/service";
import { listItems, listStores, packText, stockInStore, type Unit } from "@/lib/inventory/data";

// Pharmacy counter reads (B7a). Writes go through issue_counter_sale (app/actions/pharmacy.ts).

const rows = <T,>(r: { data: unknown; error: { message: string } | null }, what: string): T[] => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r.data ?? []) as T[];
};

/** Sellable stores this member can sell from (store_access operate or manage). */
export async function counterStores(tenantId: string, memberId: string) {
  const { stores } = await listStores(tenantId);
  const db = serviceClient();
  const out: { id: string; name: string }[] = [];
  for (const s of stores.filter((x) => x.is_active && x.is_sellable)) {
    const { data } = await db.rpc("store_access", { p_tenant: tenantId, p_member: memberId, p_store: s.id });
    if (data && data !== "view") out.push({ id: s.id, name: s.name });
  }
  return out;
}

export type CounterLot = { batch_id: string; batch_no: string; expiry_date: string | null; qty: number; price: number };
export type CounterItem = {
  id: string; name: string; generic: string | null; strength: string | null; code: string; schedule: string | null;
  rx_only: boolean; blocked: boolean; loose: boolean; vat: boolean; units: Unit[]; lots: CounterLot[]; available: number;
  /** D-147: same value = same medicine (generic, strength, form); null for combinations or no generic. Mirrors medicine_equivalent(). */
  equiv: string | null;
  barcodes: { code: string; unit_id: string }[];
};

/** What can be sold in a store: items with sellable lots (unexpired beyond the sale margin,
 *  active), earliest expiry first, exactly as allocate_stock will take them. */
export async function counterStock(tenantId: string, storeId: string): Promise<CounterItem[]> {
  const db = serviceClient();
  const [items, lots, md, it, set, tz, bc, rs] = await Promise.all([
    listItems(tenantId),
    stockInStore(tenantId, storeId),
    db.from("medicine_details").select("item_id, requires_prescription, generic_id, strength_value, strength_unit, strength_text, dosage_form, is_combination").eq("tenant_id", tenantId),
    db.from("inventory_items").select("id, allow_loose_sale, tax_category").eq("tenant_id", tenantId),
    db.from("tenant_settings").select("min_sale_shelf_days").eq("tenant_id", tenantId).single(),
    db.from("tenants").select("timezone").eq("id", tenantId).single(),
    db.from("item_barcodes").select("item_id, unit_id, barcode").eq("tenant_id", tenantId),
    db.from("stock_balances").select("batch_id, qty_reserved").eq("tenant_id", tenantId).eq("store_id", storeId).gt("qty_reserved", 0),
  ]);
  // M-45: stock on hold for a customer is not for sale (allocate_stock takes on hand minus reserved).
  const held = new Map(rows<{ batch_id: string; qty_reserved: number }>(rs, "reserved").map((r) => [r.batch_id, Number(r.qty_reserved)]));
  const codes = rows<{ item_id: string; unit_id: string; barcode: string }>(bc, "barcodes");
  const margin = Number((set.data as { min_sale_shelf_days: number } | null)?.min_sale_shelf_days ?? 0);
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: (tz.data as { timezone: string } | null)?.timezone ?? "Asia/Kathmandu" }));
  const limit = new Date(today.getTime() + margin * 86_400_000).toISOString().slice(0, 10);
  const rx = rows<{ item_id: string; requires_prescription: boolean; generic_id: string | null; strength_value: number | null; strength_unit: string | null; strength_text: string | null; dosage_form: string | null; is_combination: boolean }>(md, "medicine");
  const equiv = (id: string) => {
    const m = rx.find((x) => x.item_id === id);
    if (!m || !m.generic_id || m.is_combination) return null;
    const strength = m.strength_value === null ? `t:${(m.strength_text ?? "").trim().toLowerCase()}` : `${Number(m.strength_value)}${(m.strength_unit ?? "").toLowerCase()}`;
    return `${m.generic_id}|${strength}|${m.dosage_form ?? ""}`;
  };
  const flags = rows<{ id: string; allow_loose_sale: boolean; tax_category: string }>(it, "items");
  return items.filter((i) => i.is_active).map((i) => {
    const sell = lots.filter((l) => l.item_id === i.id && l.status === "active" && (!l.expiry_date || l.expiry_date > limit))
      .sort((a, b) => (a.expiry_date ?? "9999").localeCompare(b.expiry_date ?? "9999"))
      .map((l) => ({ batch_id: l.batch_id, batch_no: l.batch_no, expiry_date: l.expiry_date, qty: Math.max(0, Math.round((l.qty_on_hand - (held.get(l.batch_id) ?? 0)) * 1000) / 1000), price: l.sale_price_base }));
    const f = flags.find((x) => x.id === i.id);
    return {
      id: i.id, name: i.name, generic: i.generic, strength: i.strength, code: i.item_code, schedule: i.schedule_class,
      rx_only: rx.find((x) => x.item_id === i.id)?.requires_prescription ?? false,
      blocked: i.schedule_class === "controlled" || i.schedule_class === "narcotic",
      loose: f?.allow_loose_sale ?? false, vat: f?.tax_category === "vat13",
      units: i.units.filter((u) => u.can_sell), lots: sell, available: sell.reduce((s, l) => s + l.qty, 0),
      barcodes: codes.filter((b) => b.item_id === i.id).map((b) => ({ code: b.barcode, unit_id: b.unit_id })),
      equiv: equiv(i.id),
    };
  });   // out-of-stock items stay listed so the counter can offer the same medicine instead (D-147)
}

export type CounterService = { id: string; name: string; price: number };
export async function counterServices(tenantId: string): Promise<CounterService[]> {
  const r = await serviceClient().from("services").select("id, name, price_npr").eq("tenant_id", tenantId).eq("is_active", true).order("name");
  return rows<{ id: string; name: string; price_npr: number }>(r, "services").map((s) => ({ id: s.id, name: s.name, price: Number(s.price_npr) }));
}

export type BillRow = { id: string; invoice_no: string; issued_at: string; customer: string; total: number; paid: number; status: string };
/** Bills from this store since the start of the clinic's day. */
export async function todaysBills(tenantId: string, storeId: string): Promise<BillRow[]> {
  const db = serviceClient();
  const since = new Date(Date.now() - 36 * 3600_000).toISOString();
  const inv = rows<{ id: string; invoice_no: string; issued_at: string; customer_name: string | null; patient_id: string | null; total: number; status: string }>(
    await db.from("invoices").select("id, invoice_no, issued_at, customer_name, patient_id, total, status").eq("tenant_id", tenantId).eq("store_id", storeId)
      .gte("issued_at", since).order("issued_at", { ascending: false }).limit(100), "bills");
  if (!inv.length) return [];
  const [pa, pt] = await Promise.all([
    db.from("payment_allocations").select("invoice_id, amount").eq("tenant_id", tenantId).in("invoice_id", inv.map((i) => i.id)),
    db.from("patients").select("id, full_name, mrn").eq("tenant_id", tenantId).in("id", inv.map((i) => i.patient_id).filter(Boolean) as string[]),
  ]);
  const paid = rows<{ invoice_id: string; amount: number }>(pa, "payments"), pts = rows<{ id: string; full_name: string; mrn: string }>(pt, "patients");
  return inv.map((i) => {
    const p = pts.find((x) => x.id === i.patient_id);
    return { id: i.id, invoice_no: i.invoice_no, issued_at: i.issued_at, customer: p ? `${p.full_name} (${p.mrn})` : i.customer_name ?? "Walk-in",
      total: Number(i.total), paid: paid.filter((x) => x.invoice_id === i.id).reduce((s, x) => s + Number(x.amount), 0), status: i.status };
  });
}

export type BillDetail = {
  id: string; invoice_no: string; fiscal_year: string; issued_at: string; status: string; customer: string; phone: string | null;
  subtotal: number; discount: number; tax: number; total: number; paid: number; store: string; by: string;
  profile: { name: string; pan: string | null; address: string | null; phone: string | null; footer: string | null };
  lines: { n: number; text: string; qty: number; unit: string; price: number; discount: number; tax: number; total: number; lots: string }[];
  external_rx: { prescriber_name: string; prescriber_reg_no: string | null; facility: string | null; rx_date: string } | null;
  patient_id: string | null; outstanding: number; same_day: boolean; void_reason: string | null;
  returns: { id: string; return_no: string; total: number; settlement: string; created_at: string; reason: string }[];
  /** Printing: the clinic's receipt paper (Settings) and how the bill was paid. */
  paper: "80mm" | "58mm" | "a5" | "a4"; paidBy: string[]; mrn: string | null; patientName: string | null;
};
export async function getBill(tenantId: string, id: string): Promise<BillDetail | null> {
  const db = serviceClient();
  const { data: h } = await db.from("invoices").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (!h) return null;
  const [l, pa, bp, st, m, pt, ex] = await Promise.all([
    db.from("invoice_lines").select("id, line_no, description, qty, unit_price, discount_amount, tax_amount, line_total, unit_id, substitution_reason").eq("tenant_id", tenantId).eq("invoice_id", id).order("line_no"),
    db.from("payment_allocations").select("amount").eq("tenant_id", tenantId).eq("invoice_id", id),
    db.from("billing_profiles").select("*").eq("tenant_id", tenantId).eq("id", h.billing_profile_id).single(),
    h.store_id ? db.from("stores").select("name").eq("id", h.store_id).single() : Promise.resolve({ data: null }),
    db.from("tenant_members").select("display_name").eq("id", h.issued_by).single(),
    h.patient_id ? db.from("patients").select("full_name, mrn, phone").eq("id", h.patient_id).single() : Promise.resolve({ data: null }),
    h.external_prescription_id ? db.from("external_prescriptions").select("prescriber_name, prescriber_reg_no, facility, rx_date").eq("id", h.external_prescription_id).single() : Promise.resolve({ data: null }),
  ]);
  const lines = rows<{ id: string; line_no: number; description: string; qty: number; unit_price: number; discount_amount: number; tax_amount: number; line_total: number; unit_id: string | null; substitution_reason: string | null }>(l, "lines");
  const allocs = lines.length ? rows<{ invoice_line_id: string; batch_id: string; base_qty: number }>(await db.from("invoice_line_allocations").select("invoice_line_id, batch_id, base_qty").eq("tenant_id", tenantId).in("invoice_line_id", lines.map((x) => x.id)), "allocations") : [];
  const [units, batches] = await Promise.all([
    db.from("item_units").select("id, name").eq("tenant_id", tenantId).in("id", lines.map((x) => x.unit_id).filter(Boolean) as string[]),
    db.from("item_batches").select("id, batch_no, expiry_date").eq("tenant_id", tenantId).in("id", allocs.map((a) => a.batch_id)),
  ]);
  const un = rows<{ id: string; name: string }>(units, "units"), bt = rows<{ id: string; batch_no: string; expiry_date: string | null }>(batches, "batches");
  const p = pt.data as { full_name: string; mrn: string; phone: string | null } | null;
  // How it was paid (cash / online channel / from the advance), and the receipt paper.
  const payIds = rows<{ amount: number; payment_id: string }>(await db.from("payment_allocations").select("amount, payment_id").eq("tenant_id", tenantId).eq("invoice_id", id), "allocations for print").map((x) => x.payment_id);
  const [pays, setRow] = await Promise.all([
    payIds.length ? db.from("payments").select("cash_amount, online_amount, online_channel, advance_amount").eq("tenant_id", tenantId).in("id", payIds) : Promise.resolve({ data: [] }),
    db.from("tenant_settings").select("print_paper_width").eq("tenant_id", tenantId).maybeSingle(),
  ]);
  const CH: Record<string, string> = { esewa: "eSewa", khalti: "Khalti", fonepay: "Fonepay", bank_transfer: "Bank transfer", card: "Card", other: "Online" };
  const paidBy = [...new Set(((pays.data ?? []) as { cash_amount: number; online_amount: number; online_channel: string | null; advance_amount: number | null }[])
    .flatMap((x) => [Number(x.cash_amount) > 0 ? "Cash" : "", Number(x.online_amount) > 0 ? CH[x.online_channel ?? "other"] ?? "Online" : "", Number(x.advance_amount ?? 0) !== 0 ? "Advance" : ""]).filter(Boolean))];
  const paperRaw = (setRow.data as { print_paper_width: string } | null)?.print_paper_width;
  const paper = (["80mm", "58mm", "a5", "a4"].includes(paperRaw ?? "") ? paperRaw : "80mm") as BillDetail["paper"];
  const prof = bp.data as { name: string; legal_name: string; pan_vat_no: string | null; address: string | null; phone: string | null; receipt_footer: string | null } | null;
  return {
    id: h.id, invoice_no: h.invoice_no, fiscal_year: h.fiscal_year, issued_at: h.issued_at, status: h.status,
    customer: p ? `${p.full_name} (${p.mrn})` : h.customer_name ?? "Walk-in", phone: p?.phone ?? h.customer_phone ?? null,
    subtotal: Number(h.subtotal), discount: Number(h.discount_total), tax: Number(h.tax_total), total: Number(h.total),
    paid: rows<{ amount: number }>(pa, "payments").reduce((s, x) => s + Number(x.amount), 0),
    store: (st.data as { name: string } | null)?.name ?? "", by: (m.data as { display_name: string } | null)?.display_name ?? "",
    profile: { name: prof?.legal_name ?? prof?.name ?? "", pan: prof?.pan_vat_no ?? null, address: prof?.address ?? null, phone: prof?.phone ?? null, footer: prof?.receipt_footer ?? null },
    lines: lines.map((x) => ({
      n: x.line_no, text: x.substitution_reason ? `${x.description} (in place of the prescribed brand: ${x.substitution_reason})` : x.description, qty: Number(x.qty), unit: un.find((u) => u.id === x.unit_id)?.name ?? "", price: Number(x.unit_price),
      discount: Number(x.discount_amount), tax: Number(x.tax_amount), total: Number(x.line_total),
      lots: allocs.filter((a) => a.invoice_line_id === x.id).map((a) => { const b = bt.find((y) => y.id === a.batch_id); return b ? `${b.batch_no}${b.expiry_date ? ` exp ${b.expiry_date.slice(0, 7)}` : ""}` : ""; }).join(", "),
    })),
    external_rx: ex.data as BillDetail["external_rx"],
    patient_id: h.patient_id, void_reason: h.void_reason, paper, paidBy, mrn: p?.mrn ?? null, patientName: p?.full_name ?? null,
    outstanding: Number((await db.rpc("invoice_outstanding", { p_invoice: id })).data ?? 0),
    same_day: await sameBusinessDay(tenantId, h.issued_at),
    returns: rows<{ id: string; return_no: string; total: number; settlement: string; created_at: string; reason: string }>(
      await db.from("sale_returns").select("id, return_no, total, settlement, created_at, reason").eq("tenant_id", tenantId).eq("invoice_id", id).order("created_at"), "returns")
      .map((r) => ({ ...r, total: Number(r.total) })),
  };
}

async function sameBusinessDay(tenantId: string, at: string) {
  const db = serviceClient();
  const [a, b] = await Promise.all([db.rpc("business_day", { p_tenant: tenantId, p_at: at }), db.rpc("business_day", { p_tenant: tenantId, p_at: new Date().toISOString() })]);
  return Boolean(a.data) && a.data === b.data;
}

export type ReturnableLot = {
  allocation_id: string; item: string; batch_no: string; expiry_date: string | null; unit: string;
  sold: number; returned: number; price: number; can_shelve: boolean; cold: boolean;
};
/** Every lot a bill sold from, with how much can still come back (in base units). */
export async function returnableLots(tenantId: string, invoiceId: string): Promise<ReturnableLot[]> {
  const db = serviceClient();
  const lines = rows<{ id: string; description: string; item_id: string | null }>(
    await db.from("invoice_lines").select("id, description, item_id").eq("tenant_id", tenantId).eq("invoice_id", invoiceId).eq("line_type", "item"), "lines");
  if (!lines.length) return [];
  const al = rows<{ id: string; invoice_line_id: string; item_id: string; batch_id: string; base_qty: number; unit_price_base: number }>(
    await db.from("invoice_line_allocations").select("id, invoice_line_id, item_id, batch_id, base_qty, unit_price_base").eq("tenant_id", tenantId).in("invoice_line_id", lines.map((l) => l.id)), "allocations");
  const [rl, bt, un, it, tz] = await Promise.all([
    db.from("sale_return_lines").select("allocation_id, qty_base").eq("tenant_id", tenantId).in("allocation_id", al.map((a) => a.id)),
    db.from("item_batches").select("id, batch_no, expiry_date, status").eq("tenant_id", tenantId).in("id", al.map((a) => a.batch_id)),
    db.from("item_units").select("item_id, name").eq("tenant_id", tenantId).eq("is_base", true).in("item_id", al.map((a) => a.item_id)),
    db.from("inventory_items").select("id, storage_condition").eq("tenant_id", tenantId).in("id", al.map((a) => a.item_id)),
    db.rpc("stock_today", { p_tenant: tenantId }),
  ]);
  const today = String(tz.data ?? new Date().toISOString().slice(0, 10));
  const ret = rows<{ allocation_id: string; qty_base: number }>(rl, "returned"), bats = rows<{ id: string; batch_no: string; expiry_date: string | null; status: string }>(bt, "batches");
  const units = rows<{ item_id: string; name: string }>(un, "units"), items = rows<{ id: string; storage_condition: string }>(it, "items");
  return al.map((a) => {
    const b = bats.find((x) => x.id === a.batch_id);
    const cold = ["cool_2_8", "frozen"].includes(items.find((x) => x.id === a.item_id)?.storage_condition ?? "");
    return {
      allocation_id: a.id, item: lines.find((l) => l.id === a.invoice_line_id)?.description ?? "", batch_no: b?.batch_no ?? "", expiry_date: b?.expiry_date ?? null,
      unit: units.find((u) => u.item_id === a.item_id)?.name ?? "", sold: Number(a.base_qty),
      returned: ret.filter((r) => r.allocation_id === a.id).reduce((s2, r) => s2 + Number(r.qty_base), 0), price: Number(a.unit_price_base),
      can_shelve: b?.status === "active" && (!b.expiry_date || b.expiry_date > today) && !cold, cold,
    };
  });
}

export type DueRow = { patient_id: string; name: string; mrn: string; phone: string | null; bills: number; owed: number; oldest: string };
/** Patients who owe, most owed first. */
export async function patientsWithDues(tenantId: string): Promise<DueRow[]> {
  const db = serviceClient();
  const open = rows<{ patient_id: string; issued_at: string; outstanding: number }>(await db.rpc("patient_open_bills", { p_tenant: tenantId, p_patient: null }), "dues");
  if (!open.length) return [];
  const ids = [...new Set(open.map((o) => o.patient_id))];
  const pts = rows<{ id: string; full_name: string; mrn: string; phone: string | null }>(await db.from("patients").select("id, full_name, mrn, phone").eq("tenant_id", tenantId).in("id", ids), "patients");
  return ids.map((id) => {
    const mine = open.filter((o) => o.patient_id === id), p = pts.find((x) => x.id === id);
    return { patient_id: id, name: p?.full_name ?? "", mrn: p?.mrn ?? "", phone: p?.phone ?? null, bills: mine.length,
      owed: Math.round(mine.reduce((s2, o) => s2 + Number(o.outstanding), 0) * 100) / 100, oldest: mine[0]?.issued_at ?? "" };
  }).sort((a, b) => b.owed - a.owed);
}

export type QueueRx = {
  prescription_id: string; rx_number: string; issued_at: string; notes: string | null; doctor: string | null;
  patient: { id: string; mrn: string; full_name: string; sex: string; age_years: number | null; date_of_birth: string | null; created_at: string };
  allergies: string[];
  items: { id: string; item_id: string | null; medicine_text: string; strength: string | null; form: string | null; dose: string | null; frequency: string | null; duration_days: number | null; quantity: number | null; instructions: string | null; dispensed: boolean; dispensed_base: number; remaining: number | null }[];
};
/** The pharmacist's queue (C7): prescription items and allergies only. Every read is audited. */
export async function dispensingQueue(tenantId: string, memberId: string, level: string): Promise<QueueRx[] | null> {
  const { data, error } = await serviceClient().rpc("dispensing_queue", { p_tenant: tenantId, p_member: memberId, p_session_level: level });
  if (error) throw new Error(`queue: ${error.message}`);
  const j = data as { queue?: QueueRx[]; error?: string };
  return j.error ? null : (j.queue ?? []);
}

/** Every store this member may see stock in (any access), for the Pharmacy Stock tab. */
export async function stockStores(tenantId: string, memberId: string) {
  const { stores } = await listStores(tenantId);
  const db = serviceClient();
  const out: { id: string; name: string; kind: string; access: string }[] = [];
  for (const s of stores.filter((x) => x.is_active)) {
    const { data } = await db.rpc("store_access", { p_tenant: tenantId, p_member: memberId, p_store: s.id });
    if (data) out.push({ id: s.id, name: s.name, kind: s.kind, access: String(data) });
  }
  return out;
}

// ── M-45 (D-145): stock holds ─────────────────────────────────────────────────
export type HoldRow = {
  id: string; hold_no: string; status: "held" | "collected" | "released" | "expired"; expires_at: string; created_at: string; ended_at: string | null;
  end_reason: string | null; invoice_id: string | null; customer: string; phone: string | null; patient_id: string | null; by: string; note: string | null;
  lines: { item: string; batch_no: string; qty: string; rx: boolean }[]; overdue: boolean;
};
type HoldHead = {
  id: string; hold_no: string; status: HoldRow["status"]; expires_at: string; created_at: string; ended_at: string | null; end_reason: string | null;
  invoice_id: string | null; customer_name: string | null; customer_phone: string | null; patient_id: string | null; created_by: string; note: string | null;
};
type HoldLine = { id: string; hold_id: string; item_id: string; batch_id: string; unit_id: string; qty_base: number; collected_base: number; prescription_item_id: string | null; substitution_reason: string | null };
type HoldPatient = { id: string; full_name: string; mrn: string; phone: string | null; sex: string; date_of_birth: string | null; age_years: number | null; created_at: string };

async function holdDetails(tenantId: string, heads: HoldHead[]) {
  const db = serviceClient();
  const lines = heads.length
    ? rows<HoldLine>(await db.from("stock_hold_lines").select("id, hold_id, item_id, batch_id, unit_id, qty_base, collected_base, prescription_item_id, substitution_reason")
        .eq("tenant_id", tenantId).in("hold_id", heads.map((h) => h.id)).order("line_no"), "hold lines")
        .map((l) => ({ ...l, qty_base: Number(l.qty_base), collected_base: Number(l.collected_base) }))
    : [];
  const itemIds = [...new Set(lines.map((l) => l.item_id))];
  const none = Promise.resolve({ data: [], error: null });
  const [it, un, bt, pt, mb] = await Promise.all([
    itemIds.length ? db.from("inventory_items").select("id, name").eq("tenant_id", tenantId).in("id", itemIds) : none,
    itemIds.length ? db.from("item_units").select("id, item_id, name, factor_to_base, is_base, can_purchase, can_sell").eq("tenant_id", tenantId).in("item_id", itemIds) : none,
    lines.length ? db.from("item_batches").select("id, batch_no, expiry_date, sale_price_base").eq("tenant_id", tenantId).in("id", [...new Set(lines.map((l) => l.batch_id))]) : none,
    heads.some((h) => h.patient_id) ? db.from("patients").select("id, full_name, mrn, phone, sex, date_of_birth, age_years, created_at").eq("tenant_id", tenantId).in("id", heads.map((h) => h.patient_id).filter(Boolean) as string[]) : none,
    heads.length ? db.from("tenant_members").select("id, display_name").eq("tenant_id", tenantId).in("id", [...new Set(heads.map((h) => h.created_by))]) : none,
  ]);
  return {
    lines,
    items: rows<{ id: string; name: string }>(it, "items"),
    units: rows<Unit & { item_id: string }>(un, "units").map((u) => ({ ...u, factor_to_base: Number(u.factor_to_base) })),
    batches: rows<{ id: string; batch_no: string; expiry_date: string | null; sale_price_base: number }>(bt, "batches").map((b) => ({ ...b, sale_price_base: Number(b.sale_price_base) })),
    patients: rows<HoldPatient>(pt, "patients"),
    members: rows<{ id: string; display_name: string }>(mb, "members"),
  };
}

/** Holds in a store: everything still held (soonest to run out first), then what ended in the last 3 days. */
export async function listHolds(tenantId: string, storeId: string): Promise<HoldRow[]> {
  const db = serviceClient();
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const [open, ended] = await Promise.all([
    db.from("stock_holds").select("*").eq("tenant_id", tenantId).eq("store_id", storeId).eq("status", "held").order("expires_at"),
    db.from("stock_holds").select("*").eq("tenant_id", tenantId).eq("store_id", storeId).neq("status", "held").gte("ended_at", since).order("ended_at", { ascending: false }).limit(30),
  ]);
  const heads = [...rows<HoldHead>(open, "holds"), ...rows<HoldHead>(ended, "holds")];
  const d = await holdDetails(tenantId, heads);
  const now = Date.now();
  return heads.map((h) => {
    const p = d.patients.find((x) => x.id === h.patient_id);
    return {
      id: h.id, hold_no: h.hold_no, status: h.status, expires_at: h.expires_at, created_at: h.created_at, ended_at: h.ended_at, end_reason: h.end_reason, invoice_id: h.invoice_id,
      customer: p ? `${p.full_name} (${p.mrn})` : h.customer_name ?? "", phone: p?.phone ?? h.customer_phone, patient_id: h.patient_id, note: h.note,
      by: d.members.find((m) => m.id === h.created_by)?.display_name ?? "", overdue: h.status === "held" && new Date(h.expires_at).getTime() <= now,
      lines: d.lines.filter((l) => l.hold_id === h.id).map((l) => ({
        item: d.items.find((i) => i.id === l.item_id)?.name ?? "", batch_no: d.batches.find((b) => b.id === l.batch_id)?.batch_no ?? "",
        qty: packText(l.qty_base, d.units.filter((u) => u.item_id === l.item_id)), rx: Boolean(l.prescription_item_id),
      })),
    };
  });
}

export type HoldPrefill = {
  holdId: string; holdNo: string; patient: HoldPatient | null; name: string | null; phone: string | null;
  lines: { hold_line_id: string; item_id: string; unit_id: string; qty: number; batch_id: string; batch_no: string; expiry_date: string | null; price: number; held_base: number; prescription_item_id: string | null; substitution_reason: string | null }[];
};
/** A hold still held in this store, ready to collect at the counter. Each lot is one line, in
 *  the unit it was held in when that is a whole number, else in the base unit. */
export async function holdForCollection(tenantId: string, storeId: string, holdId: string): Promise<HoldPrefill | null> {
  const { data } = await serviceClient().from("stock_holds").select("*").eq("tenant_id", tenantId).eq("store_id", storeId).eq("id", holdId).eq("status", "held").maybeSingle();
  if (!data) return null;
  const h = data as HoldHead;
  const d = await holdDetails(tenantId, [h]);
  return {
    holdId: h.id, holdNo: h.hold_no, patient: d.patients[0] ?? null, name: h.customer_name, phone: h.customer_phone,
    lines: d.lines.map((l) => {
      const unit = d.units.find((u) => u.id === l.unit_id), base = d.units.find((u) => u.item_id === l.item_id && u.is_base);
      const n = unit ? l.qty_base / unit.factor_to_base : 0;
      const whole = unit && Math.abs(n - Math.round(n)) < 1e-9;
      const b = d.batches.find((x) => x.id === l.batch_id);
      return {
        hold_line_id: l.id, item_id: l.item_id, unit_id: whole ? unit!.id : base?.id ?? l.unit_id, qty: whole ? Math.round(n) : l.qty_base,
        batch_id: l.batch_id, batch_no: b?.batch_no ?? "", expiry_date: b?.expiry_date ?? null, price: b?.sale_price_base ?? 0, held_base: l.qty_base,
        prescription_item_id: l.prescription_item_id, substitution_reason: l.substitution_reason,
      };
    }),
  };
}

/** Prescription items with stock on hold (for the dispensing queue). */
export async function heldRxItems(tenantId: string, rxItemIds: string[]): Promise<Map<string, { hold_no: string; expires_at: string }>> {
  const out = new Map<string, { hold_no: string; expires_at: string }>();
  if (!rxItemIds.length) return out;
  const db = serviceClient();
  const ls = rows<{ hold_id: string; prescription_item_id: string }>(
    await db.from("stock_hold_lines").select("hold_id, prescription_item_id").eq("tenant_id", tenantId).in("prescription_item_id", rxItemIds), "held rx");
  if (!ls.length) return out;
  const hs = rows<{ id: string; hold_no: string; expires_at: string }>(
    await db.from("stock_holds").select("id, hold_no, expires_at").eq("tenant_id", tenantId).eq("status", "held").in("id", [...new Set(ls.map((l) => l.hold_id))]), "held rx holds");
  for (const l of ls) { const h = hs.find((x) => x.id === l.hold_id); if (h) out.set(l.prescription_item_id, { hold_no: h.hold_no, expires_at: h.expires_at }); }
  return out;
}
