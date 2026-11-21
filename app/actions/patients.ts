"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { audit } from "@/lib/audit";

// Patients (U3b). Demographics only (the database grants no other column); the MRN never
// changes. Clearing a duplicate flag goes through clear_duplicate_flag (manage_patients).

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
