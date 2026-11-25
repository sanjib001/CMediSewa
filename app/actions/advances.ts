"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { advanceSummary, type AdvanceSummary } from "@/lib/patients/advances";

// Patient advances (M-52): take a deposit, use it for dues, give it back. The database
// enforces who may do what (record_patient_advance / use_patient_advance, D-139).

type Fail = { ok: false; error: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHANNELS = ["esewa", "khalti", "fonepay", "bank_transfer", "card", "other"];
const ERRORS: [RegExp, string][] = [
  [/NO_PERMISSION/, "You don't have permission for this."],
  [/REASON_REQUIRED/, "Give a reason for the refund."],
  [/MORE_THAN_HELD/, "That's more than the patient has in advance."],
  [/NO_ADVANCE/, "This patient has no advance."],
  [/NO_DUES/, "This patient owes nothing."],
  [/BAD_AMOUNT/, "Enter an amount."],
  [/CHANNEL_REQUIRED/, "Choose how the online money was paid."],
  [/PATIENT_NOT_FOUND/, "That patient wasn't found."],
  [/TENANT_NOT_ACTIVE/, "The clinic isn't active yet."],
  [/NO_BILLING_PROFILE/, "Set up a billing profile first (Admin → Settings)."],
];
const friendly = (e: { message?: string } | null) => {
  const t = e?.message ?? "";
  const hit = ERRORS.find(([re]) => re.test(t));
  if (!hit) console.error("[advance action]", t);
  return hit?.[1] ?? "Something went wrong. Nothing was changed.";
};
const ctxOf = () => requireTenant({ operation: "pharmacy.counter", next: "/employee" });
const money = (n: unknown) => Math.round(Math.max(0, Number(n) || 0) * 100) / 100;
const refresh = (patientId: string) => {
  revalidatePath(`/admin/patients/${patientId}`); revalidatePath("/employee/registrar"); revalidatePath("/employee/pharmacy"); revalidatePath("/admin/billing");
};

export async function getAdvance(patientId: string): Promise<{ ok: true; summary: AdvanceSummary } | Fail> {
  const ctx = await ctxOf();
  if (!UUID.test(patientId ?? "")) return { ok: false, error: "That patient wasn't found." };
  return { ok: true, summary: await advanceSummary(ctx.tenantId, patientId) };
}

type Money = { idempotencyKey: string; patientId: string; cash: number; online: number; channel?: string | null; reference?: string | null; note?: string | null };
async function record(kind: "deposit" | "refund", input: Money): Promise<{ ok: true; id: string; receipt: string; amount: number; balance: number } | Fail> {
  const ctx = await ctxOf();
  if (!UUID.test(input.idempotencyKey ?? "") || !UUID.test(input.patientId ?? "")) return { ok: false, error: "Reload the page and try again." };
  const online = money(input.online);
  if (online > 0 && !CHANNELS.includes(input.channel ?? "")) return { ok: false, error: "Choose how the online money was paid." };
  const { data, error } = await serviceClient().rpc("record_patient_advance", {
    p_tenant: ctx.tenantId, p_idempotency_key: input.idempotencyKey, p_patient: input.patientId, p_kind: kind, p_cash: money(input.cash), p_online: online,
    p_channel: online > 0 ? input.channel : null, p_reference: (input.reference ?? "").slice(0, 80) || null, p_note: (input.note ?? "").slice(0, 200) || null,
    p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  refresh(input.patientId);
  const r = data as { advance_id: string; receipt_no: string; amount: number; balance: number };
  return { ok: true, id: r.advance_id, receipt: r.receipt_no, amount: Math.abs(Number(r.amount)), balance: Number(r.balance) };
}

export async function takeAdvance(input: Money) { return record("deposit", input); }
export async function refundAdvance(input: Money) { return record("refund", input); }

/** Pay the patient's open bills from their advance, oldest first (as much as both allow). */
export async function payFromAdvance(input: { idempotencyKey: string; patientId: string }): Promise<{ ok: true; used: number; balance: number } | Fail> {
  const ctx = await ctxOf();
  if (!UUID.test(input.idempotencyKey ?? "") || !UUID.test(input.patientId ?? "")) return { ok: false, error: "Reload the page and try again." };
  const { data, error } = await serviceClient().rpc("use_patient_advance", {
    p_tenant: ctx.tenantId, p_idempotency_key: input.idempotencyKey, p_patient: input.patientId, p_amount: null,
    p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  refresh(input.patientId);
  const r = data as { used?: number; balance: number };
  return { ok: true, used: Number(r.used ?? 0), balance: Number(r.balance) };
}
