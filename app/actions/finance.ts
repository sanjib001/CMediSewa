"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";

// Finance actions (B8a). Expenses need add_expenses; other income, openings and corrections
// need manage_expenses; corrections and openings also a password confirmed in the last 5
// minutes. The database re-checks every key and amount.

type Fail = { ok: false; error: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ERRORS: [RegExp, string][] = [
  [/BAD_AMOUNT/, "Enter an amount more than zero."],
  [/CHANNEL_REQUIRED/, "Choose how the online amount was paid."],
  [/NOTE_REQUIRED/, "Say what an \"Other\" expense was for."],
  [/DESCRIPTION_REQUIRED/, "Describe the income."],
  [/BAD_CATEGORY/, "Choose a category."],
  [/STORE_NOT_FOUND/, "Choose a store from the list."],
  [/OPENING_EXISTS/, "Opening cash and bank are already entered."],
  [/BAD_DATE/, "The opening date can't be in the future."],
  [/ALREADY_REVERSED/, "That entry is already cancelled."],
  [/REASON_REQUIRED/, "Give a reason."],
  [/REAUTH_REQUIRED/, "Confirm your password again to do this."],
  [/PASSWORD_REQUIRED/, "This needs your password. A PIN session isn't enough."],
  [/NO_PERMISSION/, "You don't have permission for this."],
  [/NOT_FOUND/, "That entry wasn't found."],
];
function friendly(e: { message?: string; code?: string } | null): string {
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  for (const [re, msg] of ERRORS) if (re.test(text)) return msg;
  console.error("[finance action]", e?.code, e?.message);
  return "Something went wrong. Nothing was changed.";
}
const done = () => { revalidatePath("/admin/expenses"); revalidatePath("/admin/finance"); };
const num = (v: FormDataEntryValue | null) => Math.round(Number(v ?? 0) * 100) / 100 || 0;
const key = (fd: FormData) => { const k = String(fd.get("key") ?? ""); return UUID.test(k) ? k : crypto.randomUUID(); };

export async function recordExpense(fd: FormData): Promise<{ ok: true; message: string } | Fail> {
  const ctx = await requireTenant({ operation: "admin.area", permission: "add_expenses", allowPendingTenant: true, next: "/admin/expenses" });
  const store = String(fd.get("store_id") ?? "");
  const { data, error } = await serviceClient().rpc("record_expense", {
    p_tenant: ctx.tenantId, p_idempotency_key: key(fd), p_category: String(fd.get("category") ?? ""), p_cash: num(fd.get("cash")), p_online: num(fd.get("online")),
    p_channel: String(fd.get("channel") ?? "") || null, p_store: UUID.test(store) ? store : null, p_note: String(fd.get("note") ?? "").slice(0, 300),
    p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  done();
  return { ok: true, message: `Expense ${(data as { expense_no: string }).expense_no} recorded.` };
}

export async function recordIncome(fd: FormData): Promise<{ ok: true; message: string } | Fail> {
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_expenses", allowPendingTenant: true, next: "/admin/expenses" });
  const { data, error } = await serviceClient().rpc("record_other_income", {
    p_tenant: ctx.tenantId, p_idempotency_key: key(fd), p_description: String(fd.get("description") ?? "").slice(0, 200), p_cash: num(fd.get("cash")), p_online: num(fd.get("online")),
    p_channel: String(fd.get("channel") ?? "") || null, p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  done();
  return { ok: true, message: `Income ${(data as { income_no: string }).income_no} recorded.` };
}

/** Cancel an expense or other income (it stays visible, struck through). Then record the right one. */
export async function reverseEntry(input: { kind: "expense" | "other_income"; id: string; reason: string }): Promise<{ ok: true } | Fail> {
  const ctx = await requireTenant({ operation: "money.correct", permission: "manage_expenses", allowPendingTenant: true, next: "/admin/expenses" });
  if (!UUID.test(input.id ?? "") || !["expense", "other_income"].includes(input.kind)) return { ok: false, error: "That entry wasn't found." };
  const { error } = await serviceClient().rpc("reverse_finance_entry", {
    p_tenant: ctx.tenantId, p_idempotency_key: crypto.randomUUID(), p_kind: input.kind, p_id: input.id, p_reason: String(input.reason ?? "").slice(0, 300),
    p_by: ctx.memberId, p_session_level: ctx.level, p_reauth_at: ctx.reauthAt?.toISOString() ?? null, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  done();
  return { ok: true };
}

export async function postOpening(fd: FormData): Promise<{ ok: true; message: string } | Fail> {
  const ctx = await requireTenant({ operation: "money.correct", permission: "manage_expenses", allowPendingTenant: true, next: "/admin/finance" });
  const asOf = String(fd.get("as_of") ?? "");
  const { error } = await serviceClient().rpc("post_finance_opening", {
    p_tenant: ctx.tenantId, p_idempotency_key: key(fd), p_cash: num(fd.get("cash")), p_bank: num(fd.get("bank")), p_as_of: /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : null,
    p_by: ctx.memberId, p_session_level: ctx.level, p_reauth_at: ctx.reauthAt?.toISOString() ?? null, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  done();
  return { ok: true, message: "Opening cash and bank recorded." };
}

export async function runFinanceCheck(): Promise<{ ok: true; message: string } | Fail> {
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_finance", allowPendingTenant: true, next: "/admin/finance" });
  const { data, error } = await serviceClient().rpc("verify_finance_integrity", { p_tenant: ctx.tenantId });
  if (error) return { ok: false, error: friendly(error) };
  done();
  const n = (data as { mismatches: number }).mismatches;
  return { ok: true, message: n ? `${n} figure(s) differ between the documents and the accounts. See below.` : "Every figure matches its documents." };
}
