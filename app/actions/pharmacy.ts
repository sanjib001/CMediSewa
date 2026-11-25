"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { toLite, type PatientLite } from "@/lib/desk/data";

// Pharmacy counter actions (B7a). A PIN session is enough (pharmacy.counter, A1); the database
// re-checks every key (pharmacy_sell, dispense_prescription, sell_prescription_only,
// override_batch), the store access, stock, prices, discounts and the credit rules.

type Fail = { ok: false; error: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ERRORS: [RegExp, string][] = [
  [/PATIENT_REQUIRED_FOR_ADVANCE/, "Only a bill with a patient on it can go into an advance."],
  [/INSUFFICIENT_STOCK/, "There isn't enough sellable stock for that quantity."],
  [/CONTROLLED_BLOCKED/, "Controlled and narcotic medicines can't be sold here yet."],
  [/RX_REQUIRED/, "This medicine needs a prescription. Link the doctor's prescription or record the outside one."],
  [/RX_NOT_VALID/, "That prescription item isn't open for this patient any more."],
  [/NO_DISPENSING_RIGHT/, "Only a verified pharmacist can sell prescription medicines."],
  [/LOT_NOT_SELLABLE/, "That batch can't be sold: it's expired, too close to expiry, or blocked."],
  [/NO_LOOSE_SALE/, "This medicine isn't sold loose. Sell whole units."],
  [/DISCOUNT_NEEDS_APPROVAL/, "That discount is above what you can give. Ask someone who can approve discounts."],
  [/OVERPAYMENT/, "More was paid than the bill total."],
  [/PATIENT_REQUIRED_FOR_DUE/, "Link a patient to leave part of the bill unpaid."],
  [/PAYMENT_REQUIRED/, "Take the full payment. Dues aren't allowed for this sale."],
  [/CREDIT_LIMIT/, "This would take the patient over their credit limit."],
  [/CHANNEL_REQUIRED/, "Choose how the online amount was paid."],
  [/STORE_NOT_SELLABLE/, "That store doesn't sell."],
  [/NO_STORE_ACCESS/, "You don't work in that store."],
  [/NO_BILLING_PROFILE/, "No billing profile is set up. Ask the admin to finish Settings."],
  [/TENANT_NOT_ACTIVE/, "The clinic isn't live yet."],
  [/ITEM_NOT_FOUND|UNIT_NOT_FOUND/, "That item or unit isn't available."],
  [/SERVICE_NOT_FOUND/, "That service isn't available."],
  [/PATIENT_NOT_FOUND/, "That patient wasn't found."],
  [/BAD_QTY/, "Quantities must be more than zero."],
  [/BAD_DISCOUNT/, "Discount is a percentage from 0 to 100."],
  [/NO_LINES/, "Add at least one item."],
  [/NO_PERMISSION/, "You don't have permission for this."],
  [/customer_phone_check/, "Enter a valid phone number."],
  [/REAUTH_REQUIRED/, "Confirm your password again to do this."],
  [/NOT_SAME_DAY/, "Only today's bills can be voided. Use a return for older bills."],
  [/HAS_RETURNS/, "Items from this bill were already returned, so it can't be voided. Return the rest instead."],
  [/ALREADY_VOID|INVOICE_VOID/, "This bill is void."],
  [/MORE_THAN_SOLD/, "That's more than this bill sold from that batch (minus earlier returns)."],
  [/MORE_THAN_DUE/, "The return is more than the bill still owes. Refund it instead."],
  [/MORE_THAN_PAID/, "The return is more than was paid on this bill. Reduce the due instead."],
  [/CANT_RESTOCK_SELLABLE/, "That batch is expired or blocked, so it can't go back on the shelf. Send it to quarantine."],
  [/COLD_CHAIN_QUARANTINE/, "Cold-chain medicines can't go back on the shelf once they leave. Send them to quarantine."],
  [/NO_QUARANTINE_STORE/, "There's no quarantine store. Ask the admin to add one."],
  [/NOT_ON_THIS_BILL/, "That batch isn't on this bill."],
  [/NOTHING_TO_RETURN/, "Enter what is coming back."],
  [/REASON_REQUIRED/, "Give a reason."],
  [/NO_DUES/, "This patient owes nothing."],
  [/BAD_AMOUNT/, "Enter an amount more than zero."],
];
function friendly(e: { message?: string; code?: string } | null): string {
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  for (const [re, msg] of ERRORS) if (re.test(text)) return msg + (/line (\d+)/.exec(text) ? ` (line ${/line (\d+)/.exec(text)![1]})` : "");
  console.error("[pharmacy action]", e?.code, e?.message);
  return "Something went wrong. Nothing was changed.";
}
const counter = () => requireTenant({ operation: "pharmacy.counter", next: "/employee/pharmacy" });

export type SaleLine =
  | { kind: "item"; item_id: string; unit_id: string; qty: number; discount_pct?: number; batch_id?: string | null; prescription_item_id?: string | null; substitution_reason?: string | null }
  | { kind: "service"; service_id: string; qty: number; discount_pct?: number };
export type SaleInput = {
  idempotencyKey: string; storeId: string; patientId?: string | null; customerName?: string; customerPhone?: string;
  lines: SaleLine[]; externalRx?: { prescriber_name: string; prescriber_reg_no?: string; facility?: string; rx_date?: string } | null;
  cash: number; online: number; channel?: string | null; reference?: string;
};

export async function issueSale(input: SaleInput): Promise<{ ok: true; id: string; no: string; total: number; due: number; fromAdvance: number } | Fail> {
  const ctx = await counter();
  if (!UUID.test(input.idempotencyKey ?? "") || !UUID.test(input.storeId ?? "")) return { ok: false, error: "Choose the store." };
  if (input.patientId && !UUID.test(input.patientId)) return { ok: false, error: "That patient wasn't found." };
  const lines = (input.lines ?? []).slice(0, 60).map((l) => l.kind === "service"
    ? { kind: "service", service_id: l.service_id, qty: Number(l.qty), discount_pct: Number(l.discount_pct ?? 0) }
    : { kind: "item", item_id: l.item_id, unit_id: l.unit_id, qty: Number(l.qty), discount_pct: Number(l.discount_pct ?? 0),
        batch_id: l.batch_id || null, prescription_item_id: l.prescription_item_id || null, substitution_reason: l.substitution_reason?.slice(0, 200) || null });
  for (const l of lines) for (const k of ["item_id", "unit_id", "service_id", "batch_id", "prescription_item_id"] as const) {
    const v = (l as Record<string, unknown>)[k];
    if (v && !UUID.test(String(v))) return { ok: false, error: "Something in the bill isn't valid. Reload the page." };
  }
  const ext = input.externalRx && input.externalRx.prescriber_name?.trim() ? {
    prescriber_name: input.externalRx.prescriber_name.trim().slice(0, 120), prescriber_reg_no: input.externalRx.prescriber_reg_no?.trim().slice(0, 40) || null,
    facility: input.externalRx.facility?.trim().slice(0, 120) || null, rx_date: /^\d{4}-\d{2}-\d{2}$/.test(input.externalRx.rx_date ?? "") ? input.externalRx.rx_date : null,
  } : null;
  const { data, error } = await serviceClient().rpc("issue_counter_sale", {
    p_tenant: ctx.tenantId, p_idempotency_key: input.idempotencyKey, p_store: input.storeId, p_patient: input.patientId || null,
    p_customer_name: String(input.customerName ?? "").slice(0, 120), p_customer_phone: String(input.customerPhone ?? "").slice(0, 20),
    p_lines: lines, p_external_rx: ext, p_cash: Number(input.cash) || 0, p_online: Number(input.online) || 0, p_channel: input.channel || null,
    p_reference: String(input.reference ?? "").slice(0, 60), p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  revalidatePath("/employee/pharmacy");
  const r = data as { invoice_id: string; invoice_no: string; total: number; due: number; from_advance?: number };
  return { ok: true, id: r.invoice_id, no: r.invoice_no, total: Number(r.total), due: Number(r.due ?? 0), fromAdvance: Number(r.from_advance ?? 0) };
}

/** Find a patient to link to the sale (needed for dues and prescriptions). */
export async function findPatient(q: string): Promise<PatientLite[]> {
  const ctx = await counter();
  if (!ctx.permissions.has("pharmacy_sell")) return [];
  const { data, error } = await serviceClient().rpc("search_patients", { p_tenant: ctx.tenantId, p_q: String(q ?? "").slice(0, 60), p_limit: 8 });
  if (error) return [];
  return (data ?? []).map(toLite);
}

const after = (id: string) => { revalidatePath("/employee/pharmacy"); revalidatePath(`/employee/pharmacy/bills/${id}`); revalidatePath("/admin/billing"); revalidatePath(`/admin/billing/${id}`); };

/** Void a whole bill: today only, nothing returned yet, password confirmed in the last 5 minutes. */
export async function voidBill(input: { id: string; reason: string }): Promise<{ ok: true } | Fail> {
  const ctx = await requireTenant({ operation: "money.correct", permission: "void_invoices", next: `/employee/pharmacy/bills/${input.id}` });
  if (!UUID.test(input.id ?? "")) return { ok: false, error: "That bill wasn't found." };
  const { error } = await serviceClient().rpc("void_invoice", {
    p_tenant: ctx.tenantId, p_idempotency_key: crypto.randomUUID(), p_invoice: input.id, p_reason: String(input.reason ?? "").slice(0, 300),
    p_by: ctx.memberId, p_session_level: ctx.level, p_reauth_at: ctx.reauthAt?.toISOString() ?? null, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  after(input.id);
  return { ok: true };
}

export type ReturnInput = {
  idempotencyKey: string; invoiceId: string; settlement: "refund_cash" | "refund_online" | "reduce_due" | "to_advance"; channel?: string | null; reason: string;
  lines: { allocation_id: string; qty_base: number; restock: "sellable" | "quarantine" | "none" }[];
};
export async function postReturn(input: ReturnInput): Promise<{ ok: true; no: string; total: number } | Fail> {
  const ctx = await requireTenant({ operation: "money.correct", permission: "sale_returns", next: `/employee/pharmacy/bills/${input.invoiceId}/return` });
  if (!UUID.test(input.idempotencyKey ?? "") || !UUID.test(input.invoiceId ?? "")) return { ok: false, error: "Reload the page and try again." };
  const lines = (input.lines ?? []).filter((l) => Number(l.qty_base) > 0).slice(0, 100);
  if (lines.some((l) => !UUID.test(l.allocation_id) || !["sellable", "quarantine", "none"].includes(l.restock))) return { ok: false, error: "Reload the page and try again." };
  const { data, error } = await serviceClient().rpc("post_sale_return", {
    p_tenant: ctx.tenantId, p_idempotency_key: input.idempotencyKey, p_invoice: input.invoiceId, p_settlement: input.settlement, p_channel: input.channel || null,
    p_reason: String(input.reason ?? "").slice(0, 300), p_lines: lines.map((l) => ({ ...l, qty_base: Number(l.qty_base) })),
    p_by: ctx.memberId, p_session_level: ctx.level, p_reauth_at: ctx.reauthAt?.toISOString() ?? null, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  after(input.invoiceId);
  const r = data as { return_no: string; total: number };
  return { ok: true, no: r.return_no, total: Number(r.total) };
}

/** Collect a patient's dues: oldest bill first. */
export async function collectDues(input: { idempotencyKey: string; patientId: string; cash: number; online: number; channel?: string | null }): Promise<{ ok: true; receipt: string; amount: number } | Fail> {
  const ctx = await counter();
  if (!UUID.test(input.idempotencyKey ?? "") || !UUID.test(input.patientId ?? "")) return { ok: false, error: "Reload the page and try again." };
  const { data, error } = await serviceClient().rpc("collect_patient_dues", {
    p_tenant: ctx.tenantId, p_idempotency_key: input.idempotencyKey, p_patient: input.patientId, p_cash: Number(input.cash) || 0, p_online: Number(input.online) || 0,
    p_channel: input.channel || null, p_reference: null, p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: /OVERPAYMENT/.test(error.message ?? "") ? "That's more than the patient owes." : friendly(error) };
  revalidatePath("/employee/pharmacy"); revalidatePath("/admin/billing");
  const r = data as { receipt_no: string; amount: number };
  return { ok: true, receipt: r.receipt_no, amount: Number(r.amount) };
}
