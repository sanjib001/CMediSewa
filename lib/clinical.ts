import "server-only";
import { serviceClient } from "@/lib/supabase/service";
import { audit } from "@/lib/audit";
import type { TenantContext } from "@/lib/auth/context";

// Server-side access to clinical data (B4b). The app role has NO privilege on clinical tables
// (migration 0027): everything goes through the care-predicate functions, which check the
// relationship, refuse PIN sessions and audit. These helpers only pass the session's tenant,
// member and assurance level, never anything from the request.

export type Allergy = { id: string; allergen: string; reaction: string | null; severity: string | null };
export type Vitals = { recorded_at: string; systolic: number | null; diastolic: number | null; pulse: number | null; temp_c: number | null;
  spo2: number | null; resp_rate: number | null; weight_kg: number | null; height_cm: number | null };
export type RxItem = { medicine_text: string; strength: string | null; form: string | null; dose: string | null; frequency: string | null;
  route: string | null; duration_days: number | null; quantity: number | null; instructions: string | null };
export type Encounter = {
  id: string; status: "draft" | "finalized"; started_at: string; finalized_at: string | null; doctor: string; mine: boolean; visit_id: string | null;
  chief_complaint: string | null; history: string | null; examination: string | null; assessment: string | null; plan: string | null; advice: string | null;
  follow_up_on: string | null; diagnoses: { text: string; icd10: string | null; is_primary: boolean }[];
  addenda: { body: string; at: string; by: string }[];
  prescription: { id: string; rx_number: string | null; status: string; notes: string | null; issued_at: string | null; items: RxItem[] } | null;
};
export type Chart = {
  scope: "write" | "read" | "vitals";
  patient: { id: string; mrn: string; full_name: string; sex: string; date_of_birth: string | null; age_years: number | null; created_at: string; blood_group: string | null; phone: string | null };
  allergies: Allergy[]; vitals: Vitals[]; encounters?: Encounter[];
};

export const CLINICAL_ERRORS: [RegExp, string][] = [
  [/PASSWORD_REQUIRED/, "Patient records need your password. A PIN session isn't enough."],
  [/NO_CLINICAL_ACCESS/, "You don't have a care relationship with this patient."],
  [/NO_PRESCRIBING_RIGHT/, "Prescribing needs a verified doctor registration."],
  [/NOT_YOUR_VISIT|NOT_YOUR_ENCOUNTER/, "Only the treating doctor can change this record."],
  [/ENCOUNTER_FINALIZED/, "This consultation is finalized. Add an addendum instead."],
  [/ENCOUNTER_EMPTY/, "Write the complaint, an assessment or a diagnosis before finalizing."],
  [/PRESCRIPTION_NOT_ISSUED/, "Issue or clear the prescription before finalizing."],
  [/PRESCRIPTION_EMPTY/, "Add at least one medicine."],
  [/PRESCRIPTION_LOCKED/, "This prescription is already issued and can't be changed."],
  [/REAUTH_REQUIRED/, "Confirm your password again to use emergency access."],
  [/NO_BREAK_GLASS_RIGHT/, "You don't have emergency access rights."],
  [/REASON_REQUIRED/, "Give a reason."],
  [/VISIT_CANCELLED/, "That visit was cancelled."],
  [/icd10_check/, "ICD-10 codes look like J06.9."],
  [/check constraint|invalid input syntax/, "A value is out of range. Check the numbers."],
];
export function clinicalError(e: { message?: string; code?: string } | null): string {
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  for (const [re, msg] of CLINICAL_ERRORS) if (re.test(text)) return msg;
  console.error("[clinical]", e?.code, e?.message);
  return "Something went wrong. Nothing was changed.";
}

/** Open a chart. Returns the refusal code instead of throwing (the DB already logged it). */
export async function openChart(ctx: TenantContext, patientId: string): Promise<Chart | { error: string }> {
  const { data, error } = await serviceClient().rpc("open_chart", { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_patient: patientId, p_session_level: ctx.level });
  if (error) return { error: clinicalError(error) };
  const j = data as Chart & { error?: string };
  if (j.error) return { error: clinicalError({ message: j.error }) };
  return j;
}

/** Call a clinical write function; a refusal is logged by the app (the DB's row rolled back with the call). */
export async function clinicalWrite<T>(ctx: TenantContext, fn: string, args: Record<string, unknown>, patientId?: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const { data, error } = await serviceClient().rpc(fn, { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_session_level: ctx.level, ...args });
  if (error) {
    if (/NO_CLINICAL_ACCESS|PASSWORD_REQUIRED|NOT_YOUR_/.test(error.message ?? "")) {
      await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: `clinical.${fn}`,
        targetType: "patient", targetId: patientId, outcome: "denied", reason: error.message?.match(/[A-Z_]{6,}/)?.[0] });
    }
    return { ok: false, error: clinicalError(error) };
  }
  return { ok: true, data: data as T };
}
