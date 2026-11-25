"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { audit } from "@/lib/audit";

// Patients (U3b). Demographics only (the database grants no other column); the MRN never
// changes. Clearing a duplicate flag goes through clear_duplicate_flag, combining two records
// through merge_patients / undo_patient_merge (all manage_patients).

type Fail = { ok: false; error: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BLOOD = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const PHONE = /^[0-9+() -]{7,20}$/, EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function updatePatient(fd: FormData): Promise<{ ok: true; message: string } | Fail> {
  const id = String(fd.get("id") ?? "");
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_patients", allowPendingTenant: true, next: `/admin/patients/${id}` });
  if (!UUID.test(id)) return { ok: false, error: "That patient wasn't found." };
  const s = (k: string, max: number) => String(fd.get(k) ?? "").trim().replace(/\s+/g, " ").slice(0, max) || null;
  const full_name = s("full_name", 120), sex = String(fd.get("sex") ?? ""), dob = s("date_of_birth", 10), ageRaw = s("age_years", 3);
  if (!full_name || full_name.length < 2) return { ok: false, error: "Enter the patient's name." };
  if (!["male", "female", "other"].includes(sex)) return { ok: false, error: "Choose the patient's sex." };
  if (dob && (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || dob > new Date().toISOString().slice(0, 10))) return { ok: false, error: "Enter a valid date of birth." };
  const age = ageRaw === null ? null : Number(ageRaw);
  if (!dob && (age === null || !Number.isInteger(age) || age < 0 || age > 130)) return { ok: false, error: "Enter an age (years) or a date of birth." };
  const phone = s("phone", 20), alt = s("alt_phone", 20), email = s("email", 120), blood = s("blood_group", 3);
  if ((phone && !PHONE.test(phone)) || (alt && !PHONE.test(alt))) return { ok: false, error: "Enter a valid phone number." };
  if (email && !EMAIL.test(email)) return { ok: false, error: "Enter a valid email." };
  if (blood && !BLOOD.includes(blood)) return { ok: false, error: "Choose a blood group from the list." };
  const next = { full_name, full_name_ne: s("full_name_ne", 120), sex, date_of_birth: dob, age_years: dob ? null : age, phone, alt_phone: alt, email: email?.toLowerCase() ?? null,
    address: s("address", 200), guardian_name: s("guardian_name", 120), guardian_relation: s("guardian_relation", 40), blood_group: blood };
  const db = serviceClient();
  const { data: before } = await db.from("patients").select(Object.keys(next).join(", ")).eq("tenant_id", ctx.tenantId).eq("id", id).is("deleted_at", null).maybeSingle();
  if (!before) return { ok: false, error: "That patient wasn't found." };
  const changed = Object.keys(next).filter((k) => String((before as unknown as Record<string, unknown>)[k] ?? "") !== String((next as Record<string, unknown>)[k] ?? ""));
  if (!changed.length) return { ok: true, message: "Nothing changed." };
  const { error } = await db.from("patients").update(next).eq("tenant_id", ctx.tenantId).eq("id", id);
  if (error) return { ok: false, error: /check/.test(error.message) ? "Some details aren't valid." : "Couldn't save. Nothing was changed." };
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: "patient.update", targetType: "patient", targetId: id, detail: { fields: changed } });
  revalidatePath(`/admin/patients/${id}`); revalidatePath("/admin/patients");
  return { ok: true, message: `Saved (${changed.length} change${changed.length > 1 ? "s" : ""}).` };
}

export async function clearDuplicate(fd: FormData): Promise<{ ok: true; message: string } | Fail> {
  const id = String(fd.get("id") ?? "");
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_patients", allowPendingTenant: true, next: `/admin/patients/${id}` });
  if (!UUID.test(id)) return { ok: false, error: "That patient wasn't found." };
  const { error } = await serviceClient().rpc("clear_duplicate_flag", { p_tenant: ctx.tenantId, p_patient: id, p_by: ctx.memberId, p_note: String(fd.get("note") ?? "").slice(0, 200) });
  if (error) return { ok: false, error: /NOT_FLAGGED/.test(error.message) ? "This patient isn't flagged any more." : /NO_PERMISSION/.test(error.message) ? "You don't have permission for this." : "Couldn't save. Nothing was changed." };
  revalidatePath(`/admin/patients/${id}`); revalidatePath("/admin/patients");
  return { ok: true, message: "Marked as a different person." };
}

const MERGE_ERRORS: [RegExp, string][] = [
  [/NO_PERMISSION/, "You don't have permission for this."],
  [/MERGE_SAME_PATIENT/, "That's this same record. Enter the other record's MRN."],
  [/PATIENT_NOT_FOUND/, "One of the two records wasn't found (it may already be combined)."],
  [/MERGE_LIVE_VISIT/, "The record being combined is in today's queue. Finish or cancel that visit first."],
  [/MERGE_APPOINTMENT_CLASH/, "Both records have a booking at the same time. Cancel one of them first."],
  [/MERGE_ALREADY_UNDONE/, "This was already undone."],
  [/MERGE_NOT_FOUND/, "That combination wasn't found."],
  [/MERGE_UNDO_LATER_FIRST/, "This record was later combined into another one. Undo that first."],
];
const mergeError = (msg: string) => MERGE_ERRORS.find(([re]) => re.test(msg))?.[1] ?? "Couldn't do that. Nothing was changed.";

// Combine two records of the same person (M-37). The page's patient and the record with the
// given MRN; `keep` says which one stays. Everything moves to the kept record; undo is on it.
export async function mergePatients(fd: FormData): Promise<{ ok: true; message: string } | Fail> {
  const id = String(fd.get("id") ?? "");
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_patients", allowPendingTenant: true, next: `/admin/patients/${id}` });
  if (!UUID.test(id)) return { ok: false, error: "That patient wasn't found." };
  const digits = String(fd.get("other_mrn") ?? "").replace(/\D/g, "");
  if (!digits || digits.length > 6) return { ok: false, error: "Enter the other record's MRN (for example 000123)." };
  if (fd.get("confirm") !== "yes") return { ok: false, error: "Tick the box to confirm they are the same person." };
  const keep = String(fd.get("keep") ?? "");
  if (keep !== "this" && keep !== "other") return { ok: false, error: "Choose which record to keep." };
  const db = serviceClient();
  const { data: other } = await db.from("patients").select("id").eq("tenant_id", ctx.tenantId).eq("mrn", digits.padStart(6, "0")).is("deleted_at", null).maybeSingle();
  if (!other) return { ok: false, error: `No current record has MRN ${digits.padStart(6, "0")}.` };
  const [kept, merged] = keep === "this" ? [id, other.id as string] : [other.id as string, id];
  const { error } = await db.rpc("merge_patients", { p_tenant: ctx.tenantId, p_kept: kept, p_merged: merged, p_by: ctx.memberId, p_reason: String(fd.get("reason") ?? "").slice(0, 200) });
  if (error) return { ok: false, error: mergeError(error.message) };
  revalidatePath("/admin/patients"); revalidatePath(`/admin/patients/${id}`); revalidatePath(`/admin/patients/${other.id}`);
  if (kept !== id) redirect(`/admin/patients/${kept}`);
  return { ok: true, message: "Combined. Everything from the other record is now on this one." };
}

export async function undoPatientMerge(fd: FormData): Promise<{ ok: true; message: string } | Fail> {
  const id = String(fd.get("id") ?? ""), merge = String(fd.get("merge") ?? "");
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_patients", allowPendingTenant: true, next: `/admin/patients/${id}` });
  if (!UUID.test(id) || !UUID.test(merge)) return { ok: false, error: "That combination wasn't found." };
  const { data, error } = await serviceClient().rpc("undo_patient_merge", { p_tenant: ctx.tenantId, p_merge: merge, p_by: ctx.memberId, p_reason: String(fd.get("reason") ?? "").slice(0, 200) });
  if (error) return { ok: false, error: mergeError(error.message) };
  revalidatePath("/admin/patients"); revalidatePath(`/admin/patients/${id}`);
  const kept = Number((data as { appointments_kept?: number } | null)?.appointments_kept ?? 0);
  return { ok: true, message: `Undone: the records are separate again.${kept ? ` ${kept} appointment${kept > 1 ? "s" : ""} checked in since stay${kept > 1 ? "" : "s"} on the kept record.` : ""}` };
}
