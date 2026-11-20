"use server";

import { revalidatePath } from "next/cache";
import { requireTenant, can, type TenantContext } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { audit } from "@/lib/audit";
import { toLite, type PatientLite } from "@/lib/desk/data";

// Front-desk actions (B4a). Each re-checks session, assurance and permission (D-28); the
// tenant always comes from the session. Bookings, check-ins and queue moves go through the
// database functions of migration 0022, which validate, lock and audit.

type Fail = { ok: false; error: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ERRORS: [RegExp, string][] = [
  [/SLOT_TAKEN/, "Someone just booked that time. Choose another."],
  [/SLOT_UNAVAILABLE/, "That time isn't available for this doctor any more."],
  [/SLOT_IN_PAST/, "That time has already passed."],
  [/BEYOND_BOOKING_WINDOW/, "That date is too far ahead for this clinic's booking window."],
  [/SESSION_FULL/, "That OPD session is full."],
  [/PATIENT_ALREADY_BOOKED/, "This patient already has an appointment at that time."],
  [/ALREADY_CHECKED_IN/, "This patient is already in this doctor's queue today."],
  [/APPOINTMENT_NOT_TODAY/, "That appointment isn't for today."],
  [/APPOINTMENT_NOT_CONFIRMED/, "That appointment isn't confirmed (it may be cancelled or already checked in)."],
  [/APPOINTMENT_MISMATCH/, "That appointment is for a different patient or doctor."],
  [/PAYMENT_REQUIRED/, "Take the full fee. This clinic doesn't allow dues."],
  [/OVERPAYMENT/, "That's more than the fee. Enter the amount actually kept."],
  [/CREDIT_LIMIT/, "This would take the patient over the clinic's due limit."],
  [/DISCOUNT_NEEDS_APPROVAL/, "That discount is above what the desk can give. Ask an admin."],
  [/BAD_DISCOUNT/, "The discount can't be more than the fee."],
  [/CHANNEL_REQUIRED/, "Choose how the online amount was paid (eSewa, Khalti, …)."],
  [/SERVICE_REQUIRED/, "Choose the service (e.g. General OPD) to bill."],
  [/SERVICE_NOT_FOUND/, "That service isn't available."],
  [/PATIENT_NOT_FOUND/, "Patient not found."],
  [/DOCTOR_NOT_FOUND/, "That doctor isn't available."],
  [/NO_BILLING_PROFILE/, "The clinic has no bill header yet. An admin must set it in Settings."],
  [/TENANT_NOT_ACTIVE/, "The clinic isn't live yet."],
  [/REASON_REQUIRED/, "Give a reason."],
  [/NOT_YET_DUE/, "You can mark a no-show only after the appointment time."],
  [/ILLEGAL_TRANSITION/, "That can't be done in the visit's current state. Refresh and try again."],
  [/VISIT_NOT_FOUND|APPOINTMENT_NOT_FOUND/, "Not found. Refresh the page."],
  [/phone_check/, "Enter a valid phone number."],
  [/email_check/, "Enter a valid email address."],
  [/check constraint/, "Some details are out of range. Check and try again."],
];
function friendly(e: { message?: string; code?: string } | null): string {
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  for (const [re, msg] of ERRORS) if (re.test(text)) return msg;
  console.error("[desk action]", e?.code, e?.message);
  return "Something went wrong. Nothing was changed.";
}
const desk = (permission: Parameters<typeof requireTenant>[0]["permission"]) =>
  requireTenant({ operation: "front_desk.operate", permission, next: "/employee/registrar" });
const done = () => { revalidatePath("/employee/registrar"); revalidatePath("/employee/opd"); };

// ── patients ─────────────────────────────────────────────────────────────────
export async function searchPatients(q: string): Promise<PatientLite[]> {
  const ctx = await desk("view_patients");
  const query = String(q ?? "").slice(0, 60);
  const { data, error } = await serviceClient().rpc("search_patients", { p_tenant: ctx.tenantId, p_q: query, p_limit: 12 });
  if (error) throw new Error(friendly(error));
  return (data ?? []).map(toLite);
}

export type RegisterInput = {
  full_name: string; sex: string; age_years?: string; date_of_birth?: string; phone?: string; address?: string;
  guardian_name?: string; full_name_ne?: string;
};
export async function registerPatient(input: RegisterInput): Promise<{ ok: true; patient: PatientLite } | Fail> {
  const ctx = await desk("manage_patients");
  const name = String(input.full_name ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2) return { ok: false, error: "Enter the patient's name." };
  if (!["male", "female", "other"].includes(input.sex)) return { ok: false, error: "Choose the patient's sex." };
  const dob = String(input.date_of_birth ?? "").trim() || null;
  const age = String(input.age_years ?? "").trim() === "" ? null : Number(input.age_years);
  if (!dob && (age === null || !Number.isInteger(age) || age < 0 || age > 130)) return { ok: false, error: "Enter an age (years) or a date of birth." };
  if (dob && (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || dob > new Date().toISOString().slice(0, 10))) return { ok: false, error: "Enter a valid date of birth." };
  const phone = String(input.phone ?? "").trim() || null;
  const { data, error } = await serviceClient().from("patients").insert({
    tenant_id: ctx.tenantId, full_name: name, full_name_ne: String(input.full_name_ne ?? "").trim() || null, sex: input.sex,
    date_of_birth: dob, age_years: dob ? null : age, phone, address: String(input.address ?? "").trim() || null,
    guardian_name: String(input.guardian_name ?? "").trim() || null, created_by: ctx.memberId,
  }).select("id, mrn, full_name, sex, date_of_birth, age_years, phone, possible_duplicate, created_at").single();
  if (error) return { ok: false, error: friendly(error) };
  const p = toLite(data as Parameters<typeof toLite>[0]);
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: "patient.register", targetType: "patient", targetId: p.id, detail: { possible_duplicate: p.possible_duplicate } });
  return { ok: true, patient: p };
}

// ── booking ──────────────────────────────────────────────────────────────────
export type Slot = { start: string; end: string; mode: "slot" | "token"; capacity: number; booked: number };
export async function listSlots(doctorId: string, date: string): Promise<Slot[]> {
  const ctx = await desk("view_appointments");
  if (!UUID.test(doctorId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const db = serviceClient();
  const [{ data, error }, { data: appts }] = await Promise.all([
    db.rpc("available_slots", { p_tenant: ctx.tenantId, p_doctor: doctorId, p_from: date, p_to: date }),
    db.from("appointments").select("scheduled_range, mode").eq("tenant_id", ctx.tenantId).eq("doctor_member_id", doctorId).eq("appointment_date", date)
      .in("status", ["requested", "confirmed", "checked_in", "in_consultation"]),
  ]);
  if (error) throw new Error(friendly(error));
  const startOf = (r: string) => new Date(r.match(/^[[(]"?([^",]+)/)![1]!).getTime();
  const taken = ((appts ?? []) as { scheduled_range: string; mode: string }[]).map((a) => startOf(a.scheduled_range));
  const now = Date.now();
  return ((data ?? []) as { slot_start: string; slot_end: string; mode: "slot" | "token"; capacity: number }[])
    .filter((s) => new Date(s.slot_start).getTime() > now)
    .map((s) => ({ start: new Date(s.slot_start).toISOString(), end: new Date(s.slot_end).toISOString(), mode: s.mode, capacity: s.capacity,
      booked: taken.filter((t) => t === new Date(s.slot_start).getTime()).length }));
}

export async function bookAppointment(input: { patientId: string; doctorId: string; start: string; serviceId?: string; reason?: string; source?: string }):
  Promise<{ ok: true; message: string } | Fail> {
  const ctx = await desk("manage_appointments");
  const source = ["phone", "walk_in", "follow_up", "desk"].includes(input.source ?? "") ? input.source! : "desk";
  const { error } = await serviceClient().rpc("book_appointment", {
    p_tenant: ctx.tenantId, p_patient: input.patientId, p_doctor: input.doctorId, p_start: input.start, p_service: input.serviceId || null,
    p_source: source, p_reason: String(input.reason ?? "").slice(0, 300) || null, p_by_kind: "member", p_by_id: ctx.memberId, p_manage_token_hash: null,
  });
  if (error) return { ok: false, error: friendly(error) };
  done();
  return { ok: true, message: "Appointment booked." };
}

export async function setAppointmentStatus(input: { appointmentId: string; status: "cancelled" | "no_show" | "confirmed"; reason?: string }):
  Promise<{ ok: true } | Fail> {
  const ctx = await desk("manage_appointments");
  const { error } = await serviceClient().rpc("set_appointment_status", {
    p_tenant: ctx.tenantId, p_appointment: input.appointmentId, p_status: input.status, p_reason: input.reason ?? null, p_by_kind: "member", p_by_id: ctx.memberId,
  });
  if (error) return { ok: false, error: friendly(error) };
  done();
  return { ok: true };
}

// ── check-in (W-12) ──────────────────────────────────────────────────────────
export type CheckInInput = {
  idempotencyKey: string; patientId: string; doctorId: string; appointmentId?: string | null; serviceId?: string | null;
  discount?: number; cash?: number; online?: number; channel?: string | null; reference?: string | null;
};
export type CheckInResult = { ok: true; token: number; invoiceNo: string | null; receiptNo: string | null; total: number; paid: number; due: number; replayed: boolean } | Fail;

export async function checkIn(input: CheckInInput): Promise<CheckInResult> {
  const ctx = await desk("manage_queue");
  if (!UUID.test(input.idempotencyKey)) return { ok: false, error: "Refresh the page and try again." };
  const { data: set } = await serviceClient().from("tenant_settings").select("consultation_billing_point").eq("tenant_id", ctx.tenantId).single<{ consultation_billing_point: string }>();
  if (set?.consultation_billing_point === "check_in" && !can(ctx, "manage_billing")) return { ok: false, error: "Taking the OPD fee needs billing permission." };
  const money = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;
  const { data, error } = await serviceClient().rpc("check_in_visit", {
    p_tenant: ctx.tenantId, p_idempotency_key: input.idempotencyKey, p_patient: input.patientId, p_doctor: input.doctorId,
    p_appointment: input.appointmentId || null, p_service: input.serviceId || null, p_discount: money(input.discount),
    p_cash: money(input.cash), p_online: money(input.online), p_channel: input.channel || null, p_reference: input.reference || null,
    p_by: ctx.memberId, p_session_level: ctx.level, p_device: ctx.deviceId,
  });
  if (error) return { ok: false, error: friendly(error) };
  const r = data as { token_no: number; invoice_no: string | null; receipt_no?: string | null; total: number; paid: number; due?: number; replayed: boolean };
  done();
  return { ok: true, token: r.token_no, invoiceNo: r.invoice_no, receiptNo: r.receipt_no ?? null, total: Number(r.total ?? 0), paid: Number(r.paid ?? 0), due: Number(r.due ?? 0), replayed: r.replayed };
}

// ── queue moves ──────────────────────────────────────────────────────────────
/** The desk cancels a waiting visit; the doctor (or anyone running the queue) calls and finishes. */
export async function moveVisit(input: { visitId: string; to: "with_doctor" | "waiting" | "done" | "cancelled"; reason?: string }): Promise<{ ok: true } | Fail> {
  const ctx: TenantContext = await requireTenant({ operation: "front_desk.operate", permission: "view_queue", next: "/employee" });
  const db = serviceClient();
  const { data: v } = await db.from("visits").select("doctor_member_id").eq("tenant_id", ctx.tenantId).eq("id", input.visitId).maybeSingle<{ doctor_member_id: string }>();
  if (!v) return { ok: false, error: "Not found. Refresh the page." };
  const ownPatient = v.doctor_member_id === ctx.memberId;
  if (input.to === "cancelled" ? !can(ctx, "manage_queue") : !(can(ctx, "manage_queue") || ownPatient)) {
    return { ok: false, error: "You can't change this visit." };
  }
  const { error } = await db.rpc("move_visit", { p_tenant: ctx.tenantId, p_visit: input.visitId, p_to: input.to, p_reason: input.reason ?? null, p_by: ctx.memberId });
  if (error) return { ok: false, error: friendly(error) };
  done();
  return { ok: true };
}

/** Doctor's "Call next": the lowest waiting token in their own queue today. */
export async function callNext(): Promise<{ ok: true; token: number | null } | Fail> {
  const ctx = await requireTenant({ operation: "front_desk.operate", permission: "view_queue", next: "/employee/opd" });
  const db = serviceClient();
  const { data: t } = await db.from("tenants").select("timezone").eq("id", ctx.tenantId).single<{ timezone: string }>();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: t?.timezone ?? "Asia/Kathmandu" }).format(new Date());
  const { data: busy } = await db.from("visits").select("id").eq("tenant_id", ctx.tenantId).eq("doctor_member_id", ctx.memberId).eq("visit_date", today).eq("status", "with_doctor").limit(1);
  if (busy?.length) return { ok: false, error: "Finish the current patient first." };
  const { data: next } = await db.from("visits").select("id, token_no").eq("tenant_id", ctx.tenantId).eq("doctor_member_id", ctx.memberId)
    .eq("visit_date", today).eq("status", "waiting").order("token_no").limit(1).maybeSingle<{ id: string; token_no: number }>();
  if (!next) return { ok: true, token: null };
  const { error } = await db.rpc("move_visit", { p_tenant: ctx.tenantId, p_visit: next.id, p_to: "with_doctor", p_reason: null, p_by: ctx.memberId });
  if (error) return { ok: false, error: friendly(error) };
  done();
  return { ok: true, token: next.token_no };
}

// ── website booking requests (B4c, D-82) ─────────────────────────────────────
/** Approve after contacting the person: link to an existing patient, or register them from the request. */
export async function approveRequest(input: { appointmentId: string; patientId?: string; newPatient?: RegisterInput }): Promise<{ ok: true; message: string } | Fail> {
  const ctx = await desk("manage_appointments");
  const db = serviceClient();
  let error: { message: string; code?: string } | null;
  if (input.patientId) {
    ({ error } = await db.rpc("approve_booking_request", { p_tenant: ctx.tenantId, p_appointment: input.appointmentId, p_patient: input.patientId, p_by: ctx.memberId }));
  } else {
    // Register + approve in ONE database transaction: a failed approval leaves no patient behind.
    const n = input.newPatient;
    if (!n) return { ok: false, error: "Choose the patient, or register them." };
    await desk("manage_patients"); // registering a patient needs that key too
    const name = String(n.full_name ?? "").trim().replace(/\s+/g, " ");
    const dob = String(n.date_of_birth ?? "").trim() || null;
    const age = String(n.age_years ?? "").trim() === "" ? null : Number(n.age_years);
    if (name.length < 2) return { ok: false, error: "Enter the patient's name." };
    if (!["male", "female", "other"].includes(n.sex)) return { ok: false, error: "Choose the patient's sex." };
    if (!dob && (age === null || !Number.isInteger(age) || age < 0 || age > 130)) return { ok: false, error: "Enter an age (years) or a date of birth." };
    ({ error } = await db.rpc("approve_booking_request_new_patient", {
      p_tenant: ctx.tenantId, p_appointment: input.appointmentId, p_full_name: name, p_sex: n.sex, p_age: age, p_dob: dob,
      p_phone: String(n.phone ?? "").trim() || null, p_by: ctx.memberId,
    }));
  }
  if (error) {
    if (/REQUEST_NOT_OPEN/.test(error.message)) return { ok: false, error: "Someone already handled this request." };
    if (/REQUEST_EXPIRED/.test(error.message)) return { ok: false, error: "The requested time has passed." };
    return { ok: false, error: friendly(error) };
  }
  done();
  revalidatePath("/admin/appointments");
  return { ok: true, message: "Approved. The patient sees it as confirmed on their link." };
}

export async function declineRequest(input: { appointmentId: string; reason: string }): Promise<{ ok: true } | Fail> {
  const r = await setAppointmentStatus({ appointmentId: input.appointmentId, status: "cancelled", reason: input.reason });
  revalidatePath("/admin/appointments");
  return r;
}
