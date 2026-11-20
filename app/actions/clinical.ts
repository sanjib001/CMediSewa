"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { clinicalError, clinicalWrite } from "@/lib/clinical";

// Doctor and nurse actions (B4b). Clinical work needs A2 (password; doctors also 2FA), which
// requireTenant enforces; the database checks the care relationship again on every call.

type R = { ok: true; message?: string } | { ok: false; error: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const write = () => requireTenant({ operation: "clinical.write", next: "/employee/opd" });
const txt = (v: unknown, max: number) => String(v ?? "").slice(0, max);
const done = () => revalidatePath("/employee/opd");

export type NoteInput = {
  encounterId: string;
  note: { chief_complaint?: string; history?: string; examination?: string; assessment?: string; plan?: string; advice?: string; follow_up_on?: string };
  diagnoses: { text: string; icd10?: string }[];
  rx: { items: { medicine_text: string; strength?: string; form?: string; dose?: string; frequency?: string; route?: string; duration_days?: string | number; quantity?: string | number; instructions?: string }[]; notes?: string };
};

function clean(input: NoteInput) {
  const n = input.note ?? {};
  const note = {
    chief_complaint: txt(n.chief_complaint, 2000), history: txt(n.history, 8000), examination: txt(n.examination, 8000),
    assessment: txt(n.assessment, 4000), plan: txt(n.plan, 4000), advice: txt(n.advice, 4000),
    follow_up_on: /^\d{4}-\d{2}-\d{2}$/.test(n.follow_up_on ?? "") ? n.follow_up_on : "",
  };
  const diagnoses = (input.diagnoses ?? []).slice(0, 20).map((d) => ({ text: txt(d.text, 200).trim(), icd10: txt(d.icd10, 10).trim() })).filter((d) => d.text);
  const items = (input.rx?.items ?? []).slice(0, 40).map((i) => ({
    medicine_text: txt(i.medicine_text, 120).trim(), strength: txt(i.strength, 40), form: txt(i.form, 30), dose: txt(i.dose, 40),
    frequency: txt(i.frequency, 60), route: txt(i.route, 30),
    duration_days: String(i.duration_days ?? "").trim() === "" ? "" : String(Math.round(Number(i.duration_days))),
    quantity: String(i.quantity ?? "").trim() === "" ? "" : String(Number(i.quantity)), instructions: txt(i.instructions, 300),
  })).filter((i) => i.medicine_text);
  return { note, diagnoses, items, rxNotes: txt(input.rx?.notes, 1000) };
}

/** Persist the draft: note + diagnoses, then the prescription when it has medicines (or had some). */
async function persist(ctx: Awaited<ReturnType<typeof write>>, input: NoteInput, hadRx: boolean): Promise<{ ok: true; rxId: string | null; items: number } | { ok: false; error: string }> {
  if (!UUID.test(input.encounterId)) return { ok: false, error: "Refresh the page." };
  const c = clean(input);
  const s = await clinicalWrite(ctx, "save_encounter", { p_encounter: input.encounterId, p_note: c.note, p_diagnoses: c.diagnoses });
  if (!s.ok) return s;
  if (!c.items.length) {
    if (hadRx) {
      const d = await clinicalWrite(ctx, "discard_prescription_draft", { p_encounter: input.encounterId });
      if (!d.ok) return d;
    }
    return { ok: true, rxId: null, items: 0 };
  }
  const p = await clinicalWrite<string>(ctx, "save_prescription", { p_encounter: input.encounterId, p_items: c.items, p_notes: c.rxNotes });
  if (!p.ok) return p;
  return { ok: true, rxId: p.data, items: c.items.length };
}

/** Save the draft (note, diagnoses, prescription). */
export async function saveConsultation(input: NoteInput & { hadRx?: boolean }): Promise<R> {
  const ctx = await write();
  const r = await persist(ctx, input, Boolean(input.hadRx));
  if (!r.ok) return r;
  done();
  return { ok: true, message: "Saved." };
}

/** Save, issue the prescription (if it has medicines), finalize the note, and finish the visit. */
export async function finalizeConsultation(input: NoteInput & { visitId: string; hadRx?: boolean }): Promise<R & { rxNumber?: string | null }> {
  const ctx = await write();
  const saved = await persist(ctx, input, Boolean(input.hadRx));
  if (!saved.ok) return saved;
  const db = serviceClient();
  let rxNumber: string | null = null;
  if (saved.rxId) {
    const issued = await clinicalWrite<string>(ctx, "issue_prescription", { p_prescription: saved.rxId });
    if (!issued.ok) return issued;
    rxNumber = issued.data;
  }
  const f = await clinicalWrite(ctx, "finalize_encounter", { p_encounter: input.encounterId });
  if (!f.ok) return f;
  if (UUID.test(input.visitId)) {
    const { error } = await db.rpc("move_visit", { p_tenant: ctx.tenantId, p_visit: input.visitId, p_to: "done", p_reason: null, p_by: ctx.memberId });
    if (error && !/ILLEGAL_TRANSITION/.test(error.message)) return { ok: false, error: clinicalError(error) };
  }
  done();
  return { ok: true, message: rxNumber ? `Finalized. Prescription ${rxNumber} is ready for the pharmacy.` : "Finalized.", rxNumber };
}

export async function addAddendum(input: { encounterId: string; body: string }): Promise<R> {
  const ctx = await write();
  const body = txt(input.body, 4000).trim();
  if (body.length < 2) return { ok: false, error: "Write the addendum." };
  const r = await clinicalWrite(ctx, "add_addendum", { p_encounter: input.encounterId, p_body: body });
  if (!r.ok) return r;
  done();
  return { ok: true, message: "Addendum added." };
}

export async function cancelPrescription(input: { prescriptionId: string; reason: string }): Promise<R> {
  const ctx = await write();
  const r = await clinicalWrite(ctx, "cancel_prescription", { p_prescription: input.prescriptionId, p_reason: txt(input.reason, 300) });
  if (!r.ok) return r;
  done();
  return { ok: true, message: "Prescription cancelled." };
}

const VITAL_KEYS = ["systolic", "diastolic", "pulse", "temp_c", "spo2", "resp_rate", "weight_kg", "height_cm"] as const;
export async function recordVitals(input: { patientId: string; visitId?: string | null; values: Partial<Record<(typeof VITAL_KEYS)[number], string | number>> }): Promise<R> {
  const ctx = await requireTenant({ operation: "clinical.write", next: "/employee/opd" });
  const v: Record<string, number> = {};
  for (const k of VITAL_KEYS) {
    const raw = String(input.values?.[k] ?? "").trim();
    if (raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: "Vitals must be numbers." };
    v[k] = n;
  }
  if (!Object.keys(v).length) return { ok: false, error: "Enter at least one reading." };
  if ((v.systolic === undefined) !== (v.diastolic === undefined)) return { ok: false, error: "Enter both numbers of the blood pressure." };
  const r = await clinicalWrite(ctx, "record_vitals", { p_patient: input.patientId, p_visit: input.visitId || null, p_v: v }, input.patientId);
  if (!r.ok) return r;
  done();
  return { ok: true, message: "Vitals recorded." };
}

export async function changeAllergy(input: { patientId: string; allergyId?: string; allergen?: string; reaction?: string; severity?: string; remove?: boolean }): Promise<R> {
  const ctx = await requireTenant({ operation: "clinical.write", next: "/employee/opd" });
  if (!input.remove && txt(input.allergen, 80).trim().length < 2) return { ok: false, error: "Name the allergen." };
  const r = await clinicalWrite(ctx, "set_allergy", {
    p_patient: input.patientId, p_allergy: input.remove ? input.allergyId : null, p_allergen: txt(input.allergen, 80), p_reaction: txt(input.reaction, 200),
    p_severity: ["mild", "moderate", "severe"].includes(input.severity ?? "") ? input.severity : "", p_remove: Boolean(input.remove),
  }, input.patientId);
  if (!r.ok) return r;
  done();
  return { ok: true, message: input.remove ? "Allergy removed." : "Allergy added." };
}

/** Emergency access (permissions.md §7): needs the key, a reason and a password confirmed within 5 minutes. */
export async function breakGlass(input: { patientId: string; reason: string }): Promise<R> {
  const ctx = await requireTenant({ operation: "break_glass", next: "/employee/opd" });
  const r = await clinicalWrite<string>(ctx, "break_glass", { p_patient: input.patientId, p_reason: txt(input.reason, 300), p_reauth_at: ctx.reauthAt?.toISOString() ?? null }, input.patientId);
  if (!r.ok) return r;
  return { ok: true, message: "Emergency access open for 60 minutes. Clinic admins are told." };
}
