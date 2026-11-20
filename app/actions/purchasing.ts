"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";

// Purchasing actions (B6a). Vendor details need manage_vendors (Admin area); posting a bill,
// an opening balance or a payment needs a password session (stock.post / money) and the
// database re-checks the key, the store access and every amount. Voiding needs a password
// confirmed in the last 5 minutes.

type Fail = { ok: false; error: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ERRORS: [RegExp, string][] = [
  [/DUPLICATE_BILL/, "This vendor's bill number is already entered. Check the purchase list."],
  [/EXPIRED_ON_ARRIVAL/, "That batch is already expired on the bill date."],
  [/SHORT_SHELF_LIFE/, "That batch expires sooner than the clinic's minimum shelf life on receipt. Give a reason to accept it."],
  [/EXPIRY_REQUIRED/, "Medicines need an expiry date."],
  [/PRICE_ABOVE_MRP/, "The sale price can't be above the MRP."],
  [/OVERPAYMENT/, "You've entered more paid than the bill total."],
  [/BAD_DISCOUNT/, "The bill discount is more than the bill."],
  [/BAD_BILL_DATE/, "The bill date can't be in the future."],
  [/BILL_NO_REQUIRED/, "Enter the vendor's bill number."],
  [/CHANNEL_REQUIRED/, "Choose how the online amount was paid."],
  [/VENDOR_NOT_FOUND/, "Choose an active vendor."],
  [/VENDOR_NAME_TAKEN/, "A vendor with that name already exists."],
  [/NAME_REQUIRED/, "Enter the vendor's name."],
  [/STORE_NOT_RECEIVING/, "That store doesn't receive stock."],
  [/NO_STORE_ACCESS/, "You don't work in that store."],
  [/NO_PERMISSION/, "You don't have permission for this."],
  [/PASSWORD_REQUIRED/, "This needs your password. A PIN session isn't enough."],
  [/REAUTH_REQUIRED/, "Confirm your password again to void a bill."],
  [/LOTS_ALREADY_USED/, "Stock from this bill has already been sold, moved or adjusted, so it can't be voided. Use a purchase return."],
  [/HAS_PAYMENTS/, "Payments were made against this bill, so it can't be voided."],
  [/ALREADY_VOID/, "This bill is already void."],
  [/ALLOCATION_TOO_LARGE/, "That's more than the bill still owes."],
  [/OPENING_EXISTS/, "This vendor already has an opening balance."],
  [/BAD_AMOUNT/, "Enter an amount more than zero."],
  [/BAD_QTY/, "Quantities must be more than zero."],
  [/NO_LINES/, "Add at least one line."],
  [/batch_no_check/, "Batch numbers use letters, numbers, / . _ - only."],
  [/pan_vat_no_check/, "PAN/VAT is 9 digits."],
  [/phone_check/, "Enter a valid phone number."],
  [/email_check/, "Enter a valid email."],
  [/check constraint/, "Some values are out of range."],
];
function friendly(e: { message?: string; code?: string } | null): string {
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  for (const [re, msg] of ERRORS) if (re.test(text)) return msg + (/line (\d+)/.exec(text) ? ` (line ${/line (\d+)/.exec(text)![1]})` : "");
  console.error("[purchasing action]", e?.code, e?.message);
  return "Something went wrong. Nothing was changed.";
}
const refresh = (vendorId?: string) => {
  revalidatePath("/admin/purchases"); revalidatePath("/admin/vendors"); revalidatePath("/admin/stock"); revalidatePath("/admin/medicines");
  if (vendorId) revalidatePath(`/admin/vendors/${vendorId}`);
};
const money = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;

export async function saveVendor(fd: FormData): Promise<{ ok: true; message: string } | Fail> {
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_vendors", allowPendingTenant: true, next: "/admin/vendors" });
  const id = String(fd.get("id") ?? "") || null;
  if (id && !UUID.test(id)) return { ok: false, error: "Vendor not found." };
  const d = Object.fromEntries(["name", "pan_vat_no", "contact_person", "phone", "email", "address", "payment_terms_days", "notes"].map((k) => [k, String(fd.get(k) ?? "").trim()]));
  const { error } = await serviceClient().rpc("save_vendor", { p_tenant: ctx.tenantId, p_vendor: id, p_d: { ...d, is_active: id ? fd.get("is_active") === "on" : true }, p_by: ctx.memberId });
  if (error) return { ok: false, error: friendly(error) };
  refresh(id ?? undefined);
  return { ok: true, message: id ? "Vendor saved." : `${d.name} added.` };
}

export async function postVendorOpening(fd: FormData): Promise<{ ok: true; message: string } | Fail> {
  const ctx = await requireTenant({ operation: "stock.post", permission: "manage_vendors", allowPendingTenant: true, next: "/admin/vendors" });
  const vendorId = String(fd.get("vendor_id") ?? "");
  const { error } = await serviceClient().rpc("post_vendor_opening", {
    p_tenant: ctx.tenantId, p_idempotency_key: String(fd.get("key") ?? "") || crypto.randomUUID(), p_vendor: vendorId, p_amount: money(fd.get("amount")),
    p_as_of: String(fd.get("as_of") ?? "") || null, p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  refresh(vendorId);
  return { ok: true, message: "Opening balance recorded." };
}

export type PurchaseLine = {
  item_id: string; unit_id: string; qty: string | number; free_qty?: string | number; unit_cost: string | number; discount_pct?: string | number; tax_rate?: number;
  batch_no?: string; mfg_date?: string; expiry_date?: string; mrp?: string | number; sale_price?: string | number; short_expiry_reason?: string;
};
export async function postPurchase(input: {
  idempotencyKey: string; vendorId: string; billNo: string; billDate: string; storeId: string; lines: PurchaseLine[];
  billDiscount?: number; roundOff?: number; cash?: number; online?: number; channel?: string | null; note?: string;
}): Promise<{ ok: true; id: string } | Fail> {
  const ctx = await requireTenant({ operation: "stock.post", permission: "manage_purchases", allowPendingTenant: true, next: "/admin/purchases/new" });
  if (!UUID.test(input.idempotencyKey) || !UUID.test(input.vendorId) || !UUID.test(input.storeId)) return { ok: false, error: "Choose the vendor and the store." };
  const { data, error } = await serviceClient().rpc("post_purchase_invoice", {
    p_tenant: ctx.tenantId, p_idempotency_key: input.idempotencyKey, p_vendor: input.vendorId, p_vendor_invoice_no: String(input.billNo ?? "").slice(0, 40),
    p_vendor_invoice_date: input.billDate, p_store: input.storeId, p_lines: (input.lines ?? []).slice(0, 200), p_bill_discount: money(input.billDiscount),
    p_round_off: money(input.roundOff), p_paid_cash: money(input.cash), p_paid_online: money(input.online), p_online_channel: input.channel || null,
    p_note: String(input.note ?? "").slice(0, 300), p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  refresh(input.vendorId);
  return { ok: true, id: data as string };
}

export async function voidPurchase(input: { id: string; reason: string }): Promise<{ ok: true } | Fail> {
  const ctx = await requireTenant({ operation: "money.correct", permission: "manage_purchases", allowPendingTenant: true, next: `/admin/purchases/${input.id}` });
  const { error } = await serviceClient().rpc("void_purchase_invoice", {
    p_tenant: ctx.tenantId, p_idempotency_key: crypto.randomUUID(), p_invoice: input.id, p_reason: String(input.reason ?? "").slice(0, 300),
    p_by: ctx.memberId, p_session_level: ctx.level, p_reauth_at: ctx.reauthAt?.toISOString() ?? null, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  refresh();
  revalidatePath(`/admin/purchases/${input.id}`);
  return { ok: true };
}

export async function payVendor(fd: FormData): Promise<{ ok: true; message: string } | Fail> {
  const ctx = await requireTenant({ operation: "stock.post", permission: "pay_vendors", allowPendingTenant: true, next: "/admin/vendors" });
  const vendorId = String(fd.get("vendor_id") ?? "");
  const cash = money(fd.get("cash")), online = money(fd.get("online"));
  const { error } = await serviceClient().rpc("post_vendor_payment", {
    p_tenant: ctx.tenantId, p_idempotency_key: String(fd.get("key") ?? "") || crypto.randomUUID(), p_vendor: vendorId, p_cash: cash, p_online: online,
    p_channel: online > 0 ? String(fd.get("channel") ?? "") : null, p_reference: String(fd.get("reference") ?? "").slice(0, 80), p_note: String(fd.get("note") ?? "").slice(0, 300),
    p_allocations: null, p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  refresh(vendorId);
  return { ok: true, message: `Payment of Rs. ${(cash + online).toLocaleString("en-IN")} recorded, applied to the oldest bills first.` };
}
