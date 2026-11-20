import "server-only";
import { serviceClient } from "@/lib/supabase/service";
import { listItems, listStores, stockInStore, type Unit } from "@/lib/inventory/data";

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
};

/** What can be sold in a store: items with sellable lots (unexpired beyond the sale margin,
 *  active), earliest expiry first, exactly as allocate_stock will take them. */
export async function counterStock(tenantId: string, storeId: string): Promise<CounterItem[]> {
  const db = serviceClient();
  const [items, lots, md, it, set, tz] = await Promise.all([
    listItems(tenantId),
    stockInStore(tenantId, storeId),
    db.from("medicine_details").select("item_id, requires_prescription").eq("tenant_id", tenantId),
    db.from("inventory_items").select("id, allow_loose_sale, tax_category").eq("tenant_id", tenantId),
    db.from("tenant_settings").select("min_sale_shelf_days").eq("tenant_id", tenantId).single(),
    db.from("tenants").select("timezone").eq("id", tenantId).single(),
  ]);
  const margin = Number((set.data as { min_sale_shelf_days: number } | null)?.min_sale_shelf_days ?? 0);
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: (tz.data as { timezone: string } | null)?.timezone ?? "Asia/Kathmandu" }));
  const limit = new Date(today.getTime() + margin * 86_400_000).toISOString().slice(0, 10);
  const rx = rows<{ item_id: string; requires_prescription: boolean }>(md, "medicine");
  const flags = rows<{ id: string; allow_loose_sale: boolean; tax_category: string }>(it, "items");
  return items.filter((i) => i.is_active).map((i) => {
    const sell = lots.filter((l) => l.item_id === i.id && l.status === "active" && (!l.expiry_date || l.expiry_date > limit))
      .sort((a, b) => (a.expiry_date ?? "9999").localeCompare(b.expiry_date ?? "9999"))
      .map((l) => ({ batch_id: l.batch_id, batch_no: l.batch_no, expiry_date: l.expiry_date, qty: l.qty_on_hand, price: l.sale_price_base }));
    const f = flags.find((x) => x.id === i.id);
    return {
      id: i.id, name: i.name, generic: i.generic, strength: i.strength, code: i.item_code, schedule: i.schedule_class,
      rx_only: rx.find((x) => x.item_id === i.id)?.requires_prescription ?? false,
      blocked: i.schedule_class === "controlled" || i.schedule_class === "narcotic",
      loose: f?.allow_loose_sale ?? false, vat: f?.tax_category === "vat13",
      units: i.units.filter((u) => u.can_sell), lots: sell, available: sell.reduce((s, l) => s + l.qty, 0),
    };
  }).filter((i) => i.available > 0 || i.lots.length > 0);
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
};
export async function getBill(tenantId: string, id: string): Promise<BillDetail | null> {
  const db = serviceClient();
  const { data: h } = await db.from("invoices").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (!h) return null;
  const [l, pa, bp, st, m, pt, ex] = await Promise.all([
    db.from("invoice_lines").select("id, line_no, description, qty, unit_price, discount_amount, tax_amount, line_total, unit_id").eq("tenant_id", tenantId).eq("invoice_id", id).order("line_no"),
    db.from("payment_allocations").select("amount").eq("tenant_id", tenantId).eq("invoice_id", id),
    db.from("billing_profiles").select("*").eq("tenant_id", tenantId).eq("id", h.billing_profile_id).single(),
    h.store_id ? db.from("stores").select("name").eq("id", h.store_id).single() : Promise.resolve({ data: null }),
    db.from("tenant_members").select("display_name").eq("id", h.issued_by).single(),
    h.patient_id ? db.from("patients").select("full_name, mrn, phone").eq("id", h.patient_id).single() : Promise.resolve({ data: null }),
    h.external_prescription_id ? db.from("external_prescriptions").select("prescriber_name, prescriber_reg_no, facility, rx_date").eq("id", h.external_prescription_id).single() : Promise.resolve({ data: null }),
  ]);
  const lines = rows<{ id: string; line_no: number; description: string; qty: number; unit_price: number; discount_amount: number; tax_amount: number; line_total: number; unit_id: string | null }>(l, "lines");
  const allocs = lines.length ? rows<{ invoice_line_id: string; batch_id: string; base_qty: number }>(await db.from("invoice_line_allocations").select("invoice_line_id, batch_id, base_qty").eq("tenant_id", tenantId).in("invoice_line_id", lines.map((x) => x.id)), "allocations") : [];
  const [units, batches] = await Promise.all([
    db.from("item_units").select("id, name").eq("tenant_id", tenantId).in("id", lines.map((x) => x.unit_id).filter(Boolean) as string[]),
    db.from("item_batches").select("id, batch_no, expiry_date").eq("tenant_id", tenantId).in("id", allocs.map((a) => a.batch_id)),
  ]);
  const un = rows<{ id: string; name: string }>(units, "units"), bt = rows<{ id: string; batch_no: string; expiry_date: string | null }>(batches, "batches");
  const p = pt.data as { full_name: string; mrn: string; phone: string | null } | null;
  const prof = bp.data as { name: string; legal_name: string; pan_vat_no: string | null; address: string | null; phone: string | null; receipt_footer: string | null } | null;
  return {
    id: h.id, invoice_no: h.invoice_no, fiscal_year: h.fiscal_year, issued_at: h.issued_at, status: h.status,
    customer: p ? `${p.full_name} (${p.mrn})` : h.customer_name ?? "Walk-in", phone: p?.phone ?? h.customer_phone ?? null,
    subtotal: Number(h.subtotal), discount: Number(h.discount_total), tax: Number(h.tax_total), total: Number(h.total),
    paid: rows<{ amount: number }>(pa, "payments").reduce((s, x) => s + Number(x.amount), 0),
    store: (st.data as { name: string } | null)?.name ?? "", by: (m.data as { display_name: string } | null)?.display_name ?? "",
    profile: { name: prof?.legal_name ?? prof?.name ?? "", pan: prof?.pan_vat_no ?? null, address: prof?.address ?? null, phone: prof?.phone ?? null, footer: prof?.receipt_footer ?? null },
    lines: lines.map((x) => ({
      n: x.line_no, text: x.description, qty: Number(x.qty), unit: un.find((u) => u.id === x.unit_id)?.name ?? "", price: Number(x.unit_price),
      discount: Number(x.discount_amount), tax: Number(x.tax_amount), total: Number(x.line_total),
      lots: allocs.filter((a) => a.invoice_line_id === x.id).map((a) => { const b = bt.find((y) => y.id === a.batch_id); return b ? `${b.batch_no}${b.expiry_date ? ` exp ${b.expiry_date.slice(0, 7)}` : ""}` : ""; }).join(", "),
    })),
    external_rx: ex.data as BillDetail["external_rx"],
  };
}

export type QueueRx = {
  prescription_id: string; rx_number: string; issued_at: string; notes: string | null; doctor: string | null;
  patient: { id: string; mrn: string; full_name: string; sex: string; age_years: number | null; date_of_birth: string | null; created_at: string };
  allergies: string[];
  items: { id: string; medicine_text: string; strength: string | null; form: string | null; dose: string | null; frequency: string | null; duration_days: number | null; quantity: number | null; instructions: string | null; dispensed: boolean }[];
};
/** The pharmacist's queue (C7): prescription items and allergies only. Every read is audited. */
export async function dispensingQueue(tenantId: string, memberId: string, level: string): Promise<QueueRx[] | null> {
  const { data, error } = await serviceClient().rpc("dispensing_queue", { p_tenant: tenantId, p_member: memberId, p_session_level: level });
  if (error) throw new Error(`queue: ${error.message}`);
  const j = data as { queue?: QueueRx[]; error?: string };
  return j.error ? null : (j.queue ?? []);
}
