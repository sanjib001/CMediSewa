import "server-only";
import { serviceClient } from "@/lib/supabase/service";

// Read side of inventory (B5a). Tenant id always from requireTenant(); joins done here.

function rows<T>(r: { data: unknown; error: { message: string } | null }, what: string): T[] {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r.data ?? []) as T[];
}

export type Unit = { id: string; name: string; factor_to_base: number; is_base: boolean; can_purchase: boolean; can_sell: boolean };
export type ItemRow = {
  id: string; item_code: string; item_type: string; name: string; is_active: boolean; generic: string | null; strength: string | null;
  dosage_form: string | null; schedule_class: string | null; category: string | null; manufacturer: string | null;
  reorder_level: number | null; min_stock_level: number | null; units: Unit[]; onHand: number;
};

/** "2 box + 3 strip + 4 tab" style, largest sellable unit first; base units otherwise. */
export function packText(qtyBase: number, units: Unit[]): string {
  const sorted = [...units].sort((a, b) => b.factor_to_base - a.factor_to_base);
  if (sorted.length <= 1) return `${trim(qtyBase)} ${sorted[0]?.name ?? ""}`.trim();
  let left = qtyBase;
  const parts: string[] = [];
  for (const u of sorted) {
    const n = u.is_base ? left : Math.floor(left / u.factor_to_base + 1e-9);
    if (n > 0) { parts.push(`${trim(n)} ${u.name}`); left = Math.round((left - n * u.factor_to_base) * 1000) / 1000; }
  }
  return parts.join(" + ") || `0 ${sorted.at(-1)!.name}`;
}
const trim = (n: number) => Number(n.toFixed(3)).toString();

export async function listItems(tenantId: string, q = ""): Promise<ItemRow[]> {
  const db = serviceClient();
  let iq = db.from("inventory_items").select("id, item_code, item_type, name, is_active, category_id, manufacturer_id, reorder_level, min_stock_level")
    .eq("tenant_id", tenantId).is("deleted_at", null).order("name").limit(300);
  const term = q.trim();
  if (term) iq = iq.or(`name.ilike.%${term.replace(/[%,()]/g, "")}%,item_code.ilike.%${term.replace(/[%,()]/g, "")}%`);
  const items = rows<{ id: string; item_code: string; item_type: string; name: string; is_active: boolean; category_id: string | null; manufacturer_id: string | null; reorder_level: number | null; min_stock_level: number | null }>(await iq, "items");
  if (!items.length) return [];
  const ids = items.map((i) => i.id);
  const [u, md, g, cat, man, bal] = await Promise.all([
    db.from("item_units").select("id, item_id, name, factor_to_base, is_base, can_purchase, can_sell").eq("tenant_id", tenantId).in("item_id", ids),
    db.from("medicine_details").select("item_id, generic_id, strength_value, strength_unit, strength_text, dosage_form, schedule_class").eq("tenant_id", tenantId).in("item_id", ids),
    db.from("generics").select("id, name").eq("tenant_id", tenantId),
    db.from("item_categories").select("id, name").eq("tenant_id", tenantId),
    db.from("manufacturers").select("id, name").eq("tenant_id", tenantId),
    db.from("stock_balances").select("item_id, qty_on_hand").eq("tenant_id", tenantId).in("item_id", ids),
  ]);
  const unitsAll = rows<Unit & { item_id: string }>(u, "units");
  const meds = rows<{ item_id: string; generic_id: string | null; strength_value: number | null; strength_unit: string | null; strength_text: string | null; dosage_form: string; schedule_class: string }>(md, "medicine");
  const name = (list: { id: string; name: string }[], id: string | null) => list.find((x) => x.id === id)?.name ?? null;
  const gens = rows<{ id: string; name: string }>(g, "generics"), cats = rows<{ id: string; name: string }>(cat, "categories"), mans = rows<{ id: string; name: string }>(man, "manufacturers");
  const bals = rows<{ item_id: string; qty_on_hand: number }>(bal, "balances");
  return items.map((i) => {
    const m = meds.find((x) => x.item_id === i.id);
    return {
      id: i.id, item_code: i.item_code, item_type: i.item_type, name: i.name, is_active: i.is_active,
      generic: m ? name(gens, m.generic_id) : null,
      strength: m ? (m.strength_text ?? (m.strength_value ? `${Number(m.strength_value)} ${m.strength_unit ?? ""}`.trim() : null)) : null,
      dosage_form: m?.dosage_form ?? null, schedule_class: m?.schedule_class ?? null,
      category: name(cats, i.category_id), manufacturer: name(mans, i.manufacturer_id),
      reorder_level: i.reorder_level === null ? null : Number(i.reorder_level), min_stock_level: i.min_stock_level === null ? null : Number(i.min_stock_level),
      units: unitsAll.filter((x) => x.item_id === i.id).map((x) => ({ ...x, factor_to_base: Number(x.factor_to_base) })).sort((a, b) => a.factor_to_base - b.factor_to_base),
      onHand: bals.filter((b) => b.item_id === i.id).reduce((s, b) => s + Number(b.qty_on_hand), 0),
    };
  });
}

export type ItemDetail = {
  id: string; item_type: string; name: string; sku: string | null; tax_category: string; category: string | null; manufacturer: string | null;
  min_stock_level: number | null; reorder_level: number | null; reorder_qty: number | null; max_stock_level: number | null;
  allow_loose_sale: boolean; storage_condition: string; is_returnable_to_vendor: boolean; is_active: boolean; notes: string | null;
  generic: string | null; strength_value: number | null; strength_unit: string | null; strength_text: string | null; dosage_form: string | null;
  route: string | null; schedule_class: string | null; dda_registration_no: string | null; pack_description: string | null;
  units: Unit[]; barcodes: { barcode: string; unit: string }[]; default_purchase_unit: string | null; default_sale_unit: string | null; hasStock: boolean;
};
export async function getItem(tenantId: string, id: string): Promise<ItemDetail | null> {
  const db = serviceClient();
  const { data: i } = await db.from("inventory_items").select("*").eq("tenant_id", tenantId).eq("id", id).is("deleted_at", null).maybeSingle();
  if (!i) return null;
  const it = i as Record<string, unknown> & { category_id: string | null; manufacturer_id: string | null; default_purchase_unit_id: string | null; default_sale_unit_id: string | null };
  const [u, md, bc, cat, man, lots] = await Promise.all([
    db.from("item_units").select("id, name, factor_to_base, is_base, can_purchase, can_sell").eq("item_id", id),
    db.from("medicine_details").select("*").eq("item_id", id).maybeSingle(),
    db.from("item_barcodes").select("barcode, unit_id").eq("item_id", id),
    it.category_id ? db.from("item_categories").select("name").eq("id", it.category_id).single() : Promise.resolve({ data: null }),
    it.manufacturer_id ? db.from("manufacturers").select("name").eq("id", it.manufacturer_id).single() : Promise.resolve({ data: null }),
    db.from("item_batches").select("id", { count: "exact", head: true }).eq("item_id", id),
  ]);
  const units = rows<Unit>(u, "units").map((x) => ({ ...x, factor_to_base: Number(x.factor_to_base) })).sort((a, b) => a.factor_to_base - b.factor_to_base);
  const m = md.data as Record<string, unknown> | null;
  const gen = m?.generic_id ? (await db.from("generics").select("name").eq("id", m.generic_id as string).single()).data as { name: string } | null : null;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id, item_type: it.item_type as string, name: it.name as string, sku: it.sku as string | null, tax_category: it.tax_category as string,
    category: (cat.data as { name: string } | null)?.name ?? null, manufacturer: (man.data as { name: string } | null)?.name ?? null,
    min_stock_level: num(it.min_stock_level), reorder_level: num(it.reorder_level), reorder_qty: num(it.reorder_qty), max_stock_level: num(it.max_stock_level),
    allow_loose_sale: it.allow_loose_sale as boolean, storage_condition: it.storage_condition as string, is_returnable_to_vendor: it.is_returnable_to_vendor as boolean,
    is_active: it.is_active as boolean, notes: it.notes as string | null,
    generic: gen?.name ?? null, strength_value: num(m?.strength_value), strength_unit: (m?.strength_unit as string) ?? null, strength_text: (m?.strength_text as string) ?? null,
    dosage_form: (m?.dosage_form as string) ?? null, route: (m?.route as string) ?? null, schedule_class: (m?.schedule_class as string) ?? null,
    dda_registration_no: (m?.dda_registration_no as string) ?? null, pack_description: (m?.pack_description as string) ?? null,
    units, barcodes: ((bc.data ?? []) as { barcode: string; unit_id: string }[]).map((b) => ({ barcode: b.barcode, unit: units.find((x) => x.id === b.unit_id)?.name ?? "" })),
    default_purchase_unit: units.find((x) => x.id === it.default_purchase_unit_id)?.name ?? null, default_sale_unit: units.find((x) => x.id === it.default_sale_unit_id)?.name ?? null,
    hasStock: (lots.count ?? 0) > 0,
  };
}

export async function masterLists(tenantId: string) {
  const db = serviceClient();
  const [g, c, m] = await Promise.all([
    db.from("generics").select("name").eq("tenant_id", tenantId).order("name").limit(2000),
    db.from("item_categories").select("name").eq("tenant_id", tenantId).order("name"),
    db.from("manufacturers").select("name").eq("tenant_id", tenantId).order("name").limit(2000),
  ]);
  const names = (r: { data: unknown }) => ((r.data ?? []) as { name: string }[]).map((x) => x.name);
  return { generics: names(g), categories: names(c), manufacturers: names(m) };
}

export type StoreRow = { id: string; code: string; name: string; kind: string; is_sellable: boolean; is_receiving: boolean; is_active: boolean };
export async function listStores(tenantId: string) {
  const db = serviceClient();
  const [s, sm, m] = await Promise.all([
    db.from("stores").select("id, code, name, kind, is_sellable, is_receiving, is_active").eq("tenant_id", tenantId).order("name"),
    db.from("store_members").select("store_id, member_id, access").eq("tenant_id", tenantId),
    db.from("tenant_members").select("id, display_name, membership_role, is_active").eq("tenant_id", tenantId).eq("is_active", true).is("deleted_at", null).order("display_name"),
  ]);
  return {
    stores: rows<StoreRow>(s, "stores"),
    access: rows<{ store_id: string; member_id: string; access: string }>(sm, "store members"),
    members: rows<{ id: string; display_name: string; membership_role: string }>(m, "members"),
  };
}

export type BatchStock = {
  batch_id: string; item_id: string; batch_no: string; expiry_date: string | null; status: string; qty_on_hand: number; unit_cost_base: number;
  mrp_base: number | null; sale_price_base: number; expired: boolean; near_expiry: boolean; critical_expiry: boolean;
};
export async function stockInStore(tenantId: string, storeId: string): Promise<BatchStock[]> {
  const { data, error } = await serviceClient().rpc("stock_by_batch", { p_tenant: tenantId, p_store: storeId });
  if (error) throw new Error(`stock: ${error.message}`);
  return ((data ?? []) as BatchStock[]).map((b) => ({ ...b, qty_on_hand: Number(b.qty_on_hand), unit_cost_base: Number(b.unit_cost_base), mrp_base: b.mrp_base === null ? null : Number(b.mrp_base), sale_price_base: Number(b.sale_price_base) }));
}

// ── B5b: transfers and counts ────────────────────────────────────────────────
export type TransferRow = {
  id: string; transfer_no: string; status: string; from_store_id: string; to_store_id: string; note: string | null; requested_at: string; decision_reason: string | null;
  items: { item: string; qty: number; unit: string; batch_no: string | null }[];
  lines: { id: string; item: string; batch_no: string; dispatched: number; received: number | null; loss: number | null; unit: string }[];
};
export async function listTransfers(tenantId: string): Promise<TransferRow[]> {
  const db = serviceClient();
  const t = rows<{ id: string; transfer_no: string; status: string; from_store_id: string; to_store_id: string; note: string | null; requested_at: string; decision_reason: string | null }>(
    await db.from("stock_transfers").select("id, transfer_no, status, from_store_id, to_store_id, note, requested_at, decision_reason").eq("tenant_id", tenantId).order("requested_at", { ascending: false }).limit(60), "transfers");
  if (!t.length) return [];
  const ids = t.map((x) => x.id);
  const [ti, tl] = await Promise.all([
    db.from("stock_transfer_items").select("transfer_id, item_id, unit_id, requested_qty, batch_id").eq("tenant_id", tenantId).in("transfer_id", ids),
    db.from("stock_transfer_lines").select("id, transfer_id, item_id, batch_id, dispatched_base_qty, received_base_qty, loss_base_qty").eq("tenant_id", tenantId).in("transfer_id", ids),
  ]);
  const its = rows<{ transfer_id: string; item_id: string; unit_id: string; requested_qty: number; batch_id: string | null }>(ti, "transfer items");
  const lns = rows<{ id: string; transfer_id: string; item_id: string; batch_id: string; dispatched_base_qty: number; received_base_qty: number | null; loss_base_qty: number | null }>(tl, "transfer lines");
  const itemIds = [...new Set([...its.map((x) => x.item_id), ...lns.map((x) => x.item_id)])];
  const batchIds = [...new Set([...its.map((x) => x.batch_id).filter(Boolean), ...lns.map((x) => x.batch_id)])] as string[];
  const [inv, un, bt] = await Promise.all([
    db.from("inventory_items").select("id, name").in("id", itemIds),
    db.from("item_units").select("id, item_id, name, is_base").in("item_id", itemIds),
    batchIds.length ? db.from("item_batches").select("id, batch_no").in("id", batchIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const nm = (id: string) => ((inv.data ?? []) as { id: string; name: string }[]).find((x) => x.id === id)?.name ?? "";
  const units = (un.data ?? []) as { id: string; item_id: string; name: string; is_base: boolean }[];
  const bno = (id: string | null) => (id ? ((bt.data ?? []) as { id: string; batch_no: string }[]).find((x) => x.id === id)?.batch_no ?? null : null);
  return t.map((x) => ({
    ...x,
    items: its.filter((i) => i.transfer_id === x.id).map((i) => ({ item: nm(i.item_id), qty: Number(i.requested_qty), unit: units.find((u) => u.id === i.unit_id)?.name ?? "", batch_no: bno(i.batch_id) })),
    lines: lns.filter((l) => l.transfer_id === x.id).map((l) => ({ id: l.id, item: nm(l.item_id), batch_no: bno(l.batch_id) ?? "", dispatched: Number(l.dispatched_base_qty),
      received: l.received_base_qty === null ? null : Number(l.received_base_qty), loss: l.loss_base_qty === null ? null : Number(l.loss_base_qty),
      unit: units.find((u) => u.item_id === l.item_id && u.is_base)?.name ?? "" })),
  }));
}

export async function getOpenCount(tenantId: string, storeId: string) {
  const db = serviceClient();
  const { data: k } = await db.from("stock_counts").select("id, count_no, blind, started_at, started_by").eq("tenant_id", tenantId).eq("store_id", storeId).eq("status", "counting").maybeSingle();
  if (!k) return null;
  const { data: ls } = await db.from("stock_count_lines").select("batch_id, counted_qty_base, system_qty_at_count, variance, counted_by").eq("count_id", (k as { id: string }).id);
  return { ...(k as { id: string; count_no: string; blind: boolean; started_at: string; started_by: string }),
    lines: ((ls ?? []) as { batch_id: string; counted_qty_base: number; system_qty_at_count: number; variance: number; counted_by: string }[])
      .map((l) => ({ ...l, counted_qty_base: Number(l.counted_qty_base), system_qty_at_count: Number(l.system_qty_at_count), variance: Number(l.variance) })) };
}

// ── B5c: alerts, purchase suggestions, reconciliation ────────────────────────
export type StockAlert = {
  kind: "expired" | "blocked" | "near_expiry" | "critical_stock" | "low_stock"; severity: "critical" | "warning";
  store_id: string; store: string; item_id: string; item: string; batch_no: string | null; expiry_date: string | null; qty: string; level: string | null; days_left: number | null;
};
const ALERT_ORDER = { expired: 0, blocked: 1, critical_stock: 2, near_expiry: 3, low_stock: 4 } as const;
export async function getAlerts(tenantId: string, storeId: string | null = null): Promise<StockAlert[]> {
  const db = serviceClient();
  const { data, error } = await db.rpc("stock_alerts", { p_tenant: tenantId, p_store: storeId });
  if (error) throw new Error(`alerts: ${error.message}`);
  const raw = (data ?? []) as { kind: StockAlert["kind"]; severity: StockAlert["severity"]; store_id: string; item_id: string; batch_no: string | null; expiry_date: string | null; qty_base: number; level: number | null; days_left: number | null }[];
  if (!raw.length) return [];
  const [items, { stores }] = await Promise.all([listItems(tenantId), listStores(tenantId)]);
  return raw.map((a) => {
    const it = items.find((i) => i.id === a.item_id);
    const units = it?.units ?? [];
    return {
      kind: a.kind, severity: a.severity, store_id: a.store_id, store: stores.find((s) => s.id === a.store_id)?.name ?? "", item_id: a.item_id, item: it?.name ?? "",
      batch_no: a.batch_no, expiry_date: a.expiry_date, qty: packText(Number(a.qty_base), units), level: a.level === null ? null : packText(Number(a.level), units), days_left: a.days_left,
    };
  }).sort((x, y) => (x.severity === y.severity ? 0 : x.severity === "critical" ? -1 : 1) || ALERT_ORDER[x.kind] - ALERT_ORDER[y.kind] || x.item.localeCompare(y.item));
}

export type Suggestion = { store_id: string; purchase_unit_id: string | null; unit_cost: number | null; store: string; item: string; item_id: string; on_hand: string; reorder_at: string | null; units: number; unit: string; est_cost: number };
export async function getSuggestions(tenantId: string): Promise<Suggestion[]> {
  const { data, error } = await serviceClient().rpc("purchase_suggestions", { p_tenant: tenantId, p_store: null });
  if (error) throw new Error(`suggestions: ${error.message}`);
  const raw = (data ?? []) as { store_id: string; item_id: string; on_hand: number; reorder_level: number | null; suggested_units: number; purchase_unit: string; purchase_unit_id: string | null; last_unit_cost_base: number | null; est_cost: number }[];
  if (!raw.length) return [];
  const [items, { stores }] = await Promise.all([listItems(tenantId), listStores(tenantId)]);
  return raw.map((s) => {
    const it = items.find((i) => i.id === s.item_id);
    const factor = it?.units.find((u) => u.id === s.purchase_unit_id)?.factor_to_base ?? 1;
    return { store_id: s.store_id, purchase_unit_id: s.purchase_unit_id, unit_cost: s.last_unit_cost_base === null ? null : Math.round(Number(s.last_unit_cost_base) * factor * 100) / 100,
      store: stores.find((x) => x.id === s.store_id)?.name ?? "", item: it?.name ?? "", item_id: s.item_id, on_hand: packText(Number(s.on_hand), it?.units ?? []),
      reorder_at: s.reorder_level === null ? null : packText(Number(s.reorder_level), it?.units ?? []), units: Number(s.suggested_units), unit: s.purchase_unit, est_cost: Number(s.est_cost) };
  }).sort((a, b) => a.item.localeCompare(b.item));
}

export async function lastReconciliation(tenantId: string) {
  const { data } = await serviceClient().from("stock_reconciliations").select("ran_at, checked, mismatches").eq("tenant_id", tenantId).order("ran_at", { ascending: false }).limit(1).maybeSingle();
  return data as { ran_at: string; checked: number; mismatches: number } | null;
}
