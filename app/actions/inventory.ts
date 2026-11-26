"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { listItems, type ItemRow } from "@/lib/inventory/data";

// Inventory actions (B5a). Item edits need the Admin area + manage_items; stock postings need
// a password session (stock.post, A2) + manage_stock + 'manage' access to the store, which the
// posting function checks again. The tenant always comes from the session.

type Fail = { ok: false; error: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ERRORS: [RegExp, string][] = [
  [/NAME_REQUIRED/, "Enter the item's name."],
  [/ONE_BASE_UNIT/, "Mark exactly one unit as the base (smallest) unit."],
  [/BASE_FACTOR_ONE/, "The base unit's factor must be 1."],
  [/UNIT_NAME_REQUIRED/, "Every unit needs a name."],
  [/DUPLICATE_UNIT/, "Two units have the same name."],
  [/UNIT_IN_USE/, "This item already has stock, so its unit sizes can't change. Add a new unit instead."],
  [/TYPE_LOCKED/, "This item already has stock, so its type can't change."],
  [/BARCODE_TAKEN/, "That barcode is already used by another item."],
  [/SKU_TAKEN/, "That SKU is already used."],
  [/ITEM_NOT_FOUND/, "Item not found."],
  [/PASSWORD_REQUIRED/, "Posting stock needs your password. A PIN session isn't enough."],
  [/NO_STORE_ACCESS/, "You don't manage this store."],
  [/STORE_NOT_RECEIVING/, "This store doesn't receive stock."],
  [/EXPIRY_REQUIRED/, "Medicines need an expiry date."],
  [/BATCH_REQUIRED/, "Enter the batch number."],
  [/BATCH_EXPIRY_MISMATCH/, "That batch number is already on file with a different expiry. Check the label, or give a reason to override."],
  [/PRICE_ABOVE_MRP/, "The sale price can't be above the MRP."],
  [/BAD_QTY/, "Quantities must be more than zero."],
  [/NO_LINES/, "Add at least one line."],
  [/expiry_date > mfg_date|item_batches_check/, "The expiry must be after the manufacturing date."],
  [/batch_no_check/, "Batch numbers use letters, numbers, / . _ - only."],
  [/barcode_check/, "Barcodes are 4–40 letters or numbers."],
  [/inventory_items_name_check/, "The name must be 2 to 120 characters."],
  [/inventory_items_sku_check/, "The SKU is too long (40 characters at most)."],
  [/22P02|invalid input syntax for type numeric/, "A number field has letters in it. Use plain numbers, e.g. 500 or 100."],
  [/check constraint/, "Some values are out of range (e.g. minimum stock above the reorder level)."],
];
function friendly(e: { message?: string; code?: string } | null): string {
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  for (const [re, msg] of ERRORS) if (re.test(text)) return msg + (/line (\d+)/.exec(text) ? ` (line ${/line (\d+)/.exec(text)![1]})` : "");
  console.error("[inventory action]", e?.code, e?.message);
  return "Something went wrong. Nothing was changed.";
}

export type ItemInput = Record<string, unknown> & {
  units: { id?: string; name: string; factor: number | string; is_base?: boolean; can_purchase?: boolean; can_sell?: boolean }[];
  barcodes?: { barcode: string; unit: string }[];
};
export async function saveItem(id: string | null, input: ItemInput): Promise<{ ok: true; id: string } | Fail> {
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_items", allowPendingTenant: true, next: "/admin/medicines" });
  if (id && !UUID.test(id)) return { ok: false, error: "Item not found." };
  const types = ["medicine", "consumable", "surgical", "lab_reagent", "other"];
  if (!types.includes(String(input.item_type))) return { ok: false, error: "Choose what kind of item this is." };
  const units = (input.units ?? []).slice(0, 8).map((u) => ({ ...u, name: String(u.name ?? "").trim(), factor: Number(u.factor) }));
  if (units.some((u) => !Number.isFinite(u.factor) || u.factor <= 0)) return { ok: false, error: "Each unit needs a size of more than zero." };
  const name = String(input.name ?? "").trim();
  if (name.length < 2) return { ok: false, error: "Enter the name on the shelf (at least 2 characters)." };
  if (name.length > 120) return { ok: false, error: "The name is too long (120 characters at most)." };
  // Number fields arrive as typed text: accept "1,000" and "500 mg" (the unit picker holds the unit);
  // anything else is refused naming the field, instead of a database error.
  const d: Record<string, unknown> = { ...input, name, units };
  const numeric: [string, string][] = [["strength_value", "Strength"], ["reorder_level", "Reorder at"], ["reorder_qty", "Reorder quantity"], ["min_stock_level", "Critical below"], ["max_stock_level", "Maximum"]];
  const num: Record<string, number | null> = {};
  for (const [key, label] of numeric) {
    const raw = String(d[key] ?? "").trim();
    if (!raw) { d[key] = ""; num[key] = null; continue; }
    const m = /^(\d[\d,]*(?:\.\d+)?)\s*([a-zA-Zµ%]+)?$/.exec(raw);
    const n = m?.[1] ? Number(m[1].replace(/,/g, "")) : NaN;
    if (!Number.isFinite(n)) {
      return { ok: false, error: key === "strength_value"
        ? `Strength must be a number, e.g. 500 (choose mg, ml… next to it). For combinations like "500 mg + 65 mg", leave it empty and use "strength as text".`
        : `${label} must be a number, e.g. 100.` };
    }
    d[key] = String(n); num[key] = n;
  }
  const lo = num.min_stock_level ?? null, ro = num.reorder_level ?? null, hi = num.max_stock_level ?? null, rq = num.reorder_qty ?? null;
  if (rq !== null && rq <= 0) return { ok: false, error: "Reorder quantity must be more than zero." };
  if (hi !== null && hi <= 0) return { ok: false, error: "Maximum must be more than zero." };
  if (lo !== null && ro !== null && lo > ro) return { ok: false, error: "Critical below can't be higher than Reorder at." };
  if (ro !== null && hi !== null && ro > hi) return { ok: false, error: "Reorder at can't be higher than Maximum." };
  const { data, error } = await serviceClient().rpc("save_item", { p_tenant: ctx.tenantId, p_item: id, p_d: d, p_by: ctx.memberId });
  if (error) return { ok: false, error: friendly(error) };
  revalidatePath("/admin/medicines");
  revalidatePath("/admin/stock");
  return { ok: true, id: data as string };
}

export async function findItems(q: string): Promise<ItemRow[]> {
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_stock", allowPendingTenant: true, next: "/admin/stock" });
  return (await listItems(ctx.tenantId, String(q ?? "").slice(0, 60))).filter((i) => i.is_active).slice(0, 15);
}

export type OpeningLine = {
  item_id: string; unit_id: string; qty: number | string; batch_no?: string; expiry_date?: string; mfg_date?: string;
  unit_cost: number | string; mrp?: number | string; sale_price?: number | string; override_reason?: string;
};
export async function postOpeningStock(input: { idempotencyKey: string; storeId: string; lines: OpeningLine[]; note?: string }):
  Promise<{ ok: true; message: string } | Fail> {
  const ctx = await requireTenant({ operation: "stock.post", permission: "manage_stock", allowPendingTenant: true, next: "/admin/stock" });
  if (!UUID.test(input.idempotencyKey) || !UUID.test(input.storeId)) return { ok: false, error: "Refresh the page and try again." };
  const lines = (input.lines ?? []).slice(0, 200);
  const { error } = await serviceClient().rpc("post_opening_stock", {
    p_tenant: ctx.tenantId, p_idempotency_key: input.idempotencyKey, p_store: input.storeId, p_lines: lines, p_note: String(input.note ?? "").slice(0, 300),
    p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  revalidatePath("/admin/stock");
  revalidatePath("/admin/medicines");
  return { ok: true, message: `Opening stock posted: ${lines.length} line${lines.length === 1 ? "" : "s"}.` };
}

// ── B5b: transfers, adjustments, counts, block/recall, disposal, stores ──────
const MORE_ERRORS: [RegExp, string][] = [
  [/INSUFFICIENT_STOCK|stock_balances_check/, "Not enough stock for that. Stock on hold for customers (Pharmacy → Holds) can't be moved, counted below or disposed of until the hold ends."],
  [/LOT_NOT_SELLABLE/, "That lot is expired or blocked, so it can only go to quarantine."],
  [/TRANSFER_NOT_APPROVED/, "This transfer needs approval before it can be sent."],
  [/TRANSFER_NOT_DISPATCHED/, "This transfer hasn't been sent yet."],
  [/TRANSFER_NOT_OPEN/, "This transfer has already been handled."],
  [/RECEIVE_MUST_MATCH/, "Received plus lost must equal what was sent for every line."],
  [/LOSS_REASON_REQUIRED/, "Give a reason for anything lost in transit."],
  [/NO_PERMISSION/, "You don't have permission for this."],
  [/COUNT_ALREADY_OPEN/, "A count is already open for this store."],
  [/COUNT_NOT_OPEN/, "This count is closed."],
  [/COUNT_OUTDATED/, "Stock moved since this lot was counted. Count it again."],
  [/OTHER_MEMBER_MUST_POST/, "Someone other than the counter must post this count (clinic setting)."],
  [/DISPOSE_FROM_QUARANTINE/, "Stock is disposed from the quarantine store. Move it there first."],
  [/LOT_REQUIRED/, "Choose the lot."],
  [/BATCH_NOT_FOUND/, "No lot of this medicine has that batch number. Check the label."],
  [/BAD_BATCH_NO/, "Batch numbers use letters, numbers, / . _ - only."],
  [/RECALL_NOT_FOUND/, "That recall wasn't found."],
  [/REASON_REQUIRED/, "Give a reason."],
  [/stores_tenant_id_code_key|stores_code/, "A store with that code already exists."],
];
function friendlier(e: { message?: string; code?: string } | null): string {
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  for (const [re, msg] of MORE_ERRORS) if (re.test(text)) return msg;
  return friendly(e);
}
type R = { ok: true; message?: string } | Fail;
const stockOp = () => requireTenant({ operation: "stock.operate", permission: "view_stock", allowPendingTenant: true, next: "/admin/stock" });
const stockPost = (permission: "manage_stock" | "block_batches" | "dispose_stock") =>
  requireTenant({ operation: "stock.post", permission, allowPendingTenant: true, next: "/admin/stock" });
const refresh = () => { revalidatePath("/admin/stock"); revalidatePath("/admin/stock/counts"); revalidatePath("/admin/medicines"); };
const rpc = async (fn: string, args: Record<string, unknown>): Promise<{ ok: true; data: unknown } | Fail> => {
  const { data, error } = await serviceClient().rpc(fn, args);
  return error ? { ok: false, error: friendlier(error) } : { ok: true, data };
};

export type TransferItem = { item_id: string; unit_id: string; qty: number | string; batch_id?: string | null };
async function requestTransfer(input: { fromStoreId: string; toStoreId: string; items: TransferItem[]; note?: string }): Promise<R & { id?: string }> {
  const ctx = await stockOp();
  const r = await rpc("request_transfer", { p_tenant: ctx.tenantId, p_by: ctx.memberId, p_from: input.fromStoreId, p_to: input.toStoreId, p_items: (input.items ?? []).slice(0, 100), p_note: String(input.note ?? "").slice(0, 300) });
  if (!r.ok) return r;
  refresh();
  return { ok: true, id: r.data as string, message: "Transfer created." };
}
async function dispatchTransfer(input: { id: string; idempotencyKey: string }): Promise<R> {
  const ctx = await stockOp();
  const r = await rpc("dispatch_transfer", { p_tenant: ctx.tenantId, p_idempotency_key: input.idempotencyKey, p_transfer: input.id, p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId });
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Sent." };
}
async function receiveTransfer(input: { id: string; idempotencyKey: string; lines?: { line_id: string; received_base_qty: number; loss_base_qty: number; loss_reason?: string }[] }): Promise<R> {
  const ctx = await stockOp();
  const r = await rpc("receive_transfer", { p_tenant: ctx.tenantId, p_idempotency_key: input.idempotencyKey, p_transfer: input.id, p_lines: input.lines ?? null, p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId });
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Received." };
}
// Transfers have no screen of their own (D-149): moving a lot to quarantine is the one use, done in one click.
/** Move a lot into quarantine (request, send and receive). */
export async function moveToQuarantine(input: { fromStoreId: string; batchId: string; itemId: string; unitId: string; qtyBase: number; quarantineId: string }): Promise<R> {
  const created = await requestTransfer({ fromStoreId: input.fromStoreId, toStoreId: input.quarantineId, items: [{ item_id: input.itemId, unit_id: input.unitId, qty: input.qtyBase, batch_id: input.batchId }], note: "Moved to quarantine" });
  if (!created.ok || !created.id) return created;
  const sent = await dispatchTransfer({ id: created.id, idempotencyKey: crypto.randomUUID() });
  if (!sent.ok) return { ok: false, error: `${sent.error} Nothing was moved. Try again.` };
  const got = await receiveTransfer({ id: created.id, idempotencyKey: crypto.randomUUID() });
  if (!got.ok) return { ok: false, error: `Sent, but not yet received in quarantine: ${got.error}` };
  return { ok: true, message: "Moved to quarantine." };
}

export type AdjustLine = { batch_id?: string; qty_base?: number; item_id?: string; unit_id?: string; qty?: number | string; batch_no?: string; expiry_date?: string; unit_cost?: number | string; mrp?: number | string; sale_price?: number | string };
export async function adjustStock(input: { idempotencyKey: string; storeId: string; reason: string; note?: string; lines: AdjustLine[] }): Promise<R> {
  const ctx = await stockPost("manage_stock");
  const r = await rpc("post_stock_adjustment", { p_tenant: ctx.tenantId, p_idempotency_key: input.idempotencyKey, p_store: input.storeId, p_reason: input.reason,
    p_note: String(input.note ?? "").slice(0, 300), p_lines: (input.lines ?? []).slice(0, 100), p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId });
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Adjustment posted." };
}

export async function setBatchStatus(input: { batchId: string; status: "active" | "blocked" | "recalled"; reason: string }): Promise<R> {
  const ctx = await stockPost("block_batches");
  const r = await rpc("set_batch_status", { p_tenant: ctx.tenantId, p_by: ctx.memberId, p_batch: input.batchId, p_status: input.status, p_reason: String(input.reason ?? "").slice(0, 300), p_session_level: ctx.level });
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: input.status === "active" ? "Unblocked." : input.status === "recalled" ? "Marked recalled in every store." : "Blocked in every store." };
}

export async function startCount(input: { storeId: string; blind: boolean }): Promise<R & { id?: string }> {
  const ctx = await stockOp();
  const r = await rpc("start_stock_count", { p_tenant: ctx.tenantId, p_by: ctx.memberId, p_store: input.storeId, p_blind: input.blind, p_note: null });
  if (!r.ok) return r;
  refresh();
  return { ok: true, id: r.data as string };
}
export async function recordCount(input: { countId: string; batchId: string; countedBase: number; reason?: string }): Promise<R> {
  const ctx = await stockOp();
  const r = await rpc("record_count", { p_tenant: ctx.tenantId, p_by: ctx.memberId, p_count: input.countId, p_batch: input.batchId, p_counted: input.countedBase, p_reason: input.reason ?? null });
  return r.ok ? { ok: true } : r;
}
export async function finishCount(input: { countId: string; action: "post" | "cancel"; idempotencyKey: string }): Promise<R> {
  const ctx = input.action === "post" ? await stockPost("manage_stock") : await stockOp();
  const r = input.action === "post"
    ? await rpc("post_stock_count", { p_tenant: ctx.tenantId, p_idempotency_key: input.idempotencyKey, p_count: input.countId, p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId })
    : await rpc("cancel_stock_count", { p_tenant: ctx.tenantId, p_by: ctx.memberId, p_count: input.countId });
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: input.action === "post" ? "Count posted. Differences are now in stock and the accounts." : "Count cancelled." };
}

export async function disposeStock(input: { idempotencyKey: string; storeId: string; method: string; contractor?: string; witness: string; note?: string; lines: { batch_id: string; qty_base: number }[] }): Promise<R> {
  const ctx = await stockPost("dispose_stock");
  const r = await rpc("post_disposal", { p_tenant: ctx.tenantId, p_idempotency_key: input.idempotencyKey, p_store: input.storeId, p_method: input.method,
    p_contractor: input.contractor ?? null, p_witness: input.witness, p_note: input.note ?? null, p_lines: input.lines, p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId });
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Disposal recorded." };
}

export async function runReconciliation(): Promise<{ ok: true; message: string } | Fail> {
  const ctx = await requireTenant({ operation: "stock.post", permission: "manage_stock", allowPendingTenant: true, next: "/admin/stock/reorder" });
  const { data, error } = await serviceClient().rpc("reconcile_stock_balances", { p_tenant: ctx.tenantId, p_by: ctx.memberId });
  if (error) return { ok: false, error: friendly(error) };
  const r = data as { checked: number; mismatches: number };
  revalidatePath("/admin/stock/reorder");
  return { ok: true, message: r.mismatches ? `${r.mismatches} balance(s) differed from the ledger and were repaired (logged for review).` : `All ${r.checked} balances match the stock ledger.` };
}

// ── M-51 bulk recall ─────────────────────────────────────────────────────────
/** Recall one batch number of a medicine in every store (all its lots); staff are notified. */
export async function recallBatch(input: { itemId: string; batchNo: string; reason: string; reference?: string }): Promise<R & { id?: string }> {
  const ctx = await stockPost("block_batches");
  if (!UUID.test(input.itemId ?? "")) return { ok: false, error: "Choose the medicine." };
  const batch = String(input.batchNo ?? "").trim().toUpperCase().slice(0, 30);
  if (!batch) return { ok: false, error: "Enter the batch number." };
  if (String(input.reason ?? "").trim().length < 3) return { ok: false, error: "Give the reason for the recall." };
  const r = await rpc("recall_batch", { p_tenant: ctx.tenantId, p_by: ctx.memberId, p_item: input.itemId, p_batch_no: batch, p_reason: String(input.reason).slice(0, 300),
    p_reference: String(input.reference ?? "").slice(0, 80) || null, p_session_level: ctx.level });
  if (!r.ok) return r;
  refresh(); revalidatePath("/admin/stock/recalls");
  const d = r.data as { recall_id: string; lots: number; bills: number };
  return { ok: true, id: d.recall_id, message: `Recalled: ${d.lots} lot${d.lots === 1 ? "" : "s"}, sold on ${d.bills} bill${d.bills === 1 ? "" : "s"}.` };
}

// ── Pharmacy track step 2 (D-143): per-store stock levels for an item ─────────
/** Set (or clear, when all are blank) one store's min / reorder / max for an item, in base units. */
