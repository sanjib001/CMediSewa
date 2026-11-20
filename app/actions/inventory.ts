"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { audit } from "@/lib/audit";
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
  const { data, error } = await serviceClient().rpc("save_item", { p_tenant: ctx.tenantId, p_item: id, p_d: { ...input, units }, p_by: ctx.memberId });
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

/** Who works in which store (permissions.md §5a). Changing it is staff management. */
export async function setStoreAccess(input: { storeId: string; memberId: string; access: "view" | "operate" | "manage" | "none" }): Promise<{ ok: true } | Fail> {
  const ctx = await requireTenant({ operation: "staff.manage", permission: "manage_staff", allowPendingTenant: true, next: "/admin/stock" });
  const db = serviceClient();
  const { error } = input.access === "none"
    ? await db.from("store_members").delete().eq("tenant_id", ctx.tenantId).eq("store_id", input.storeId).eq("member_id", input.memberId)
    : await db.from("store_members").upsert({ tenant_id: ctx.tenantId, store_id: input.storeId, member_id: input.memberId, access: input.access }, { onConflict: "store_id,member_id" });
  if (error) return { ok: false, error: /foreign key/.test(error.message) ? "That store or person isn't at this clinic." : friendly(error) };
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: "store.access_change", targetType: "store", targetId: input.storeId, detail: { member: input.memberId, access: input.access } });
  revalidatePath("/admin/stock");
  return { ok: true };
}
