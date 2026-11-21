"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";

// A doctor's own diary (U5): leave (manage_own_leave) and follow-ups (write_consultation). Every
// call is for the signed-in doctor only; the database re-checks keys, dates and slot rules.

type Fail = { ok: false; error: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{2}:\d{2}$/;
const ERR: [RegExp, string][] = [
  [/BAD_DATES/, "Choose today or a later date, and an end date on or after the start."],
  [/TOO_LONG/, "Leave can be entered up to 60 days at a time."],
  [/BAD_TIMES/, "Part-day leave is for one day, with an end time after the start."],
  [/NOT_A_DOCTOR/, "You aren't set up as an OPD doctor here."],
  [/NOT_YOUR_PATIENT/, "You can book a follow-up only for a patient you have seen."],
  [/IN_THE_PAST/, "Choose a time in the future."],
  [/SLOT_TAKEN|exclu|overlap/i, "That time was just taken. Choose another."],
  [/SESSION_FULL/, "That token session is full. Choose another time."],
  [/PATIENT_ALREADY_BOOKED/, "The patient already has an appointment at that time."],
  [/SLOT_IN_PAST|TOO_SHORT_NOTICE/, "That time is too soon. Choose a later one."],
  [/BEYOND_BOOKING_WINDOW/, "That is further ahead than the clinic books."],
  [/OUTSIDE_SCHEDULE|SLOT_UNAVAILABLE|NOT_A_SLOT/, "That isn't one of your OPD times."],
  [/NO_PERMISSION/, "You don't have permission for this."],
  [/NOT_FOUND/, "That leave isn't there any more."],
];
const friendly = (m: string) => ERR.find(([re]) => re.test(m))?.[1] ?? "Something went wrong. Nothing was changed.";
const refresh = () => { revalidatePath("/employee/schedule"); revalidatePath("/employee/opd"); revalidatePath("/employee/registrar"); };

export async function addMyLeave(fd: FormData): Promise<{ ok: true; message: string } | Fail> {
  const ctx = await requireTenant({ operation: "employee.area", permission: "manage_own_leave", next: "/employee/schedule" });
  const from = String(fd.get("from") ?? ""), to = String(fd.get("to") ?? "") || from;
  const start = String(fd.get("start_time") ?? ""), end = String(fd.get("end_time") ?? "");
  if (!DATE.test(from) || !DATE.test(to)) return { ok: false, error: "Choose the dates." };
  if ((start || end) && (!TIME.test(start) || !TIME.test(end))) return { ok: false, error: "Enter both times for part-day leave." };
  const { data, error } = await serviceClient().rpc("add_own_leave", {
    p_tenant: ctx.tenantId, p_member: ctx.memberId, p_from: from, p_to: to, p_start: start || null, p_end: end || null, p_reason: String(fd.get("reason") ?? "").slice(0, 200),
  });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  const r = data as { days: number; appointments: number };
  if (!r.days) return { ok: true, message: "You were already on leave on those days." };
  return { ok: true, message: `Leave added for ${r.days} day${r.days > 1 ? "s" : ""}.${r.appointments ? ` ${r.appointments} booked appointment${r.appointments > 1 ? "s are" : " is"} on those days; the desk has been told to move ${r.appointments > 1 ? "them" : "it"}.` : ""}` };
}

export async function removeMyLeave(fd: FormData): Promise<{ ok: true; message: string } | Fail> {
  const ctx = await requireTenant({ operation: "employee.area", permission: "manage_own_leave", next: "/employee/schedule" });
  const id = String(fd.get("id") ?? "");
  if (!UUID.test(id)) return { ok: false, error: "That leave isn't there any more." };
  const { error } = await serviceClient().rpc("remove_own_leave", { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_exception: id });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  return { ok: true, message: "Leave removed." };
}

export type MySlot = { start: string; mode: "slot" | "token"; free: boolean };
/** My free OPD times on a day (for a follow-up). */
export async function listMySlots(date: string): Promise<MySlot[]> {
  const ctx = await requireTenant({ operation: "clinical.write", permission: "write_consultation", next: "/employee/opd" });
  if (!DATE.test(date)) return [];
  const db = serviceClient();
  const [{ data }, { data: appts }] = await Promise.all([
    db.rpc("available_slots", { p_tenant: ctx.tenantId, p_doctor: ctx.memberId, p_from: date, p_to: date }),
    db.from("appointments").select("scheduled_range, mode").eq("tenant_id", ctx.tenantId).eq("doctor_member_id", ctx.memberId).eq("appointment_date", date)
      .in("status", ["requested", "confirmed", "checked_in", "in_consultation"]),
  ]);
  const startOf = (r: string) => new Date(/^[[(]"?([^",]+)/.exec(r)![1]!).getTime();
  const taken = ((appts ?? []) as { scheduled_range: string }[]).map((a) => startOf(a.scheduled_range));
  const now = Date.now();
  return ((data ?? []) as { slot_start: string; mode: "slot" | "token"; capacity: number }[]).filter((s) => Date.parse(s.slot_start) > now).map((s) => {
    const n = taken.filter((t) => t === Date.parse(s.slot_start)).length;
    return { start: new Date(s.slot_start).toISOString(), mode: s.mode, free: s.mode === "token" ? n < s.capacity : n === 0 };
  });
}

export async function bookFollowUp(input: { patientId: string; start: string }): Promise<{ ok: true } | Fail> {
  const ctx = await requireTenant({ operation: "clinical.write", permission: "write_consultation", next: "/employee/opd" });
  if (!UUID.test(input.patientId ?? "") || Number.isNaN(Date.parse(input.start ?? ""))) return { ok: false, error: "Choose a time." };
  const { error } = await serviceClient().rpc("book_follow_up", { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_patient: input.patientId, p_start: new Date(input.start).toISOString() });
  if (error) return { ok: false, error: friendly(error.message) };
  refresh();
  return { ok: true };
}
