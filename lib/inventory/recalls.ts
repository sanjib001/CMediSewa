import "server-only";
import { serviceClient } from "@/lib/supabase/service";

// Bulk recalls (M-51): the clinic's recalls, one recall's lots with what is left in each
// store, and who bought it (recall_affected_sales: block_batches, audited).

const must = <T,>(r: { data: unknown; error: { message: string } | null }, what: string): T[] => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r.data ?? []) as T[];
};

export type RecallRow = { id: string; item: string; batch_no: string; reason: string; reference: string | null; at: string; by: string };

export async function listRecalls(tenantId: string): Promise<RecallRow[]> {
  const db = serviceClient();
  const rs = must<{ id: string; item_id: string; batch_no: string; reason: string; reference: string | null; recalled_at: string; recalled_by: string }>(
    await db.from("batch_recalls").select("id, item_id, batch_no, reason, reference, recalled_at, recalled_by").eq("tenant_id", tenantId).order("recalled_at", { ascending: false }).limit(100), "recalls");
  if (!rs.length) return [];
  const [items, mem] = await Promise.all([
    db.from("inventory_items").select("id, name").eq("tenant_id", tenantId).in("id", [...new Set(rs.map((r) => r.item_id))]),
    db.from("tenant_members").select("id, display_name").eq("tenant_id", tenantId).in("id", [...new Set(rs.map((r) => r.recalled_by))]),
  ]);
  const name = new Map(must<{ id: string; name: string }>(items, "items").map((i) => [i.id, i.name]));
  const who = new Map(must<{ id: string; display_name: string }>(mem, "members").map((m) => [m.id, m.display_name]));
  return rs.map((r) => ({ id: r.id, item: name.get(r.item_id) ?? "", batch_no: r.batch_no, reason: r.reason, reference: r.reference, at: r.recalled_at, by: who.get(r.recalled_by) ?? "" }));
}

/** Medicines with their batch numbers on file, for the recall form. */
export async function recallChoices(tenantId: string): Promise<{ id: string; name: string; batches: string[] }[]> {
  const db = serviceClient();
  const [items, lots] = await Promise.all([
    db.from("inventory_items").select("id, name").eq("tenant_id", tenantId).is("deleted_at", null).order("name").limit(3000),
    db.from("item_batches").select("item_id, batch_no").eq("tenant_id", tenantId).limit(20000),
  ]);
  const by = new Map<string, Set<string>>();
  for (const l of must<{ item_id: string; batch_no: string }>(lots, "lots")) (by.get(l.item_id) ?? by.set(l.item_id, new Set()).get(l.item_id)!).add(l.batch_no);
  return must<{ id: string; name: string }>(items, "items").filter((i) => by.has(i.id)).map((i) => ({ id: i.id, name: i.name, batches: [...by.get(i.id)!].sort() }));
}

export type RecallDetail = RecallRow & {
  lots: { batch_id: string; expiry: string | null; status: string; was: string; stores: { id: string; name: string; qty: number }[] }[];
  sales: { invoice_id: string; invoice_no: string; at: string; store: string | null; patient_id: string | null; who: string; mrn: string | null; phone: string | null; sold: number; returned: number }[];
  unit: string;
};

export async function getRecall(tenantId: string, memberId: string, level: string, id: string): Promise<RecallDetail | null> {
  const db = serviceClient();
  const { data: r } = await db.from("batch_recalls").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (!r) return null;
  const [item, mem, rl, sales, unit] = await Promise.all([
    db.from("inventory_items").select("name").eq("id", r.item_id).single(),
    db.from("tenant_members").select("display_name").eq("id", r.recalled_by).maybeSingle(),
    db.from("batch_recall_lots").select("batch_id, old_status").eq("recall_id", id),
    db.rpc("recall_affected_sales", { p_tenant: tenantId, p_by: memberId, p_recall: id, p_session_level: level }),
    db.from("item_units").select("name").eq("item_id", r.item_id).eq("is_base", true).maybeSingle(),
  ]);
  const lots = must<{ batch_id: string; old_status: string }>(rl, "recall lots");
  const ids = lots.map((l) => l.batch_id);
  const [bs, bal, stores] = await Promise.all([
    db.from("item_batches").select("id, expiry_date, status").in("id", ids),
    db.from("stock_balances").select("batch_id, store_id, qty_on_hand").eq("tenant_id", tenantId).in("batch_id", ids),
    db.from("stores").select("id, name").eq("tenant_id", tenantId),
  ]);
  const sname = new Map(must<{ id: string; name: string }>(stores, "stores").map((s) => [s.id, s.name]));
  const bmap = new Map(must<{ id: string; expiry_date: string | null; status: string }>(bs, "lots").map((b) => [b.id, b]));
  const balances = must<{ batch_id: string; store_id: string; qty_on_hand: number }>(bal, "balances");
  return {
    id: r.id, item: (item.data as { name: string } | null)?.name ?? "", batch_no: r.batch_no, reason: r.reason, reference: r.reference, at: r.recalled_at,
    by: (mem.data as { display_name: string } | null)?.display_name ?? "", unit: (unit.data as { name: string } | null)?.name ?? "",
    lots: lots.map((l) => ({ batch_id: l.batch_id, expiry: bmap.get(l.batch_id)?.expiry_date ?? null, status: bmap.get(l.batch_id)?.status ?? "", was: l.old_status,
      stores: balances.filter((b) => b.batch_id === l.batch_id && Number(b.qty_on_hand) !== 0).map((b) => ({ id: b.store_id, name: sname.get(b.store_id) ?? "", qty: Number(b.qty_on_hand) })) })),
    sales: must<{ invoice_id: string; invoice_no: string; issued_at: string; store_name: string | null; patient_id: string | null; patient_name: string | null; mrn: string | null; phone: string | null; customer_name: string | null; qty_sold_base: number; qty_returned_base: number }>(sales, "who bought it")
      .map((s) => ({ invoice_id: s.invoice_id, invoice_no: s.invoice_no, at: s.issued_at, store: s.store_name, patient_id: s.patient_id, who: s.patient_name ?? s.customer_name ?? "Walk-in",
        mrn: s.mrn, phone: s.phone, sold: Number(s.qty_sold_base), returned: Number(s.qty_returned_base) })),
  };
}
