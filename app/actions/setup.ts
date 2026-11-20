"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { hmac, newToken } from "@/lib/auth/hmac";
import { audit } from "@/lib/audit";
import { PERMISSION_KEYS, isClinical, type Operation, type Permission } from "@/lib/permissions";
import { BLOCKER_LABELS } from "@/lib/tenant/setup-data";

// Clinic setup actions (B3, Admin area). Each one re-checks the session, the operation's
// assurance level and the permission (D-28). The tenant id ALWAYS comes from the session,
// never from the form, and every write is filtered by it, so a forged id from another clinic
// matches nothing (and composite foreign keys refuse cross-clinic links anyway).

export type FormResult = { ok: true; message?: string; link?: string } | { ok: false; error: string };

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const opt = (fd: FormData, k: string) => s(fd, k) || null;
const num = (fd: FormData, k: string) => (s(fd, k) === "" ? null : Number(s(fd, k)));
const on = (fd: FormData, k: string) => fd.get(k) === "on";
const ids = (fd: FormData, k: string) => fd.getAll(k).map(String).filter((v) => /^[0-9a-f-]{36}$/.test(v));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const guard = (operation: Operation, permission: Permission, next: string) =>
  requireTenant({ operation, permission, allowPendingTenant: true, next });

function kathmanduToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(new Date());
}

const ERRORS: [RegExp, string][] = [
  [/23P01|conflicting key|exclusion/, "That OPD time overlaps another window for this doctor on the same day."],
  [/departments_name/, "A department with that name already exists."],
  [/services_name/, "A service with that name already exists."],
  [/tenant_roles_name/, "A role with that name already exists."],
  [/member_credentials_tenant_id_profession_registration_no/, "That registration number is already on file at this clinic."],
  [/tenant_members_tenant_id_username|username.*unique|members_username/, "That username is already used at this clinic."],
  [/tenant_members_tenant_id_email|email.*unique|members_email/, "That email is already used at this clinic."],
  [/username_check/, "Usernames are 3–32 lowercase letters, numbers, dots, dashes or underscores."],
  [/email_check/, "Enter a valid email address."],
  [/LAST_ADMIN/, "The clinic must keep at least one active admin."],
  [/CANNOT_VERIFY_OWN_CREDENTIAL/, "Someone else must verify your own registration."],
  [/VERIFIER_NOT_TENANT_ADMIN/, "Only a clinic admin can verify registrations."],
  [/MEMBER_NOT_INVITABLE/, "This person has already joined."],
  [/MEMBER_NOT_FOUND|ROLE_NOT_FOUND|CREDENTIAL_NOT_FOUND/, "That record was not found at this clinic."],
  [/NOT_TENANT_ADMIN/, "Only a clinic admin can do this."],
  [/unknown permission|invalid permission|PERMISSION/i, "That role includes a permission that doesn't exist."],
  [/home_route_check/, "Choose a valid home screen."],
  [/check constraint/, "Some values are outside the allowed range."],
];
function friendly(e: { message?: string; code?: string } | null): string {
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  for (const [re, msg] of ERRORS) if (re.test(text)) return msg;
  console.error("[setup action]", e?.code, e?.message);
  return "Something went wrong. Nothing was changed.";
}
function done(path: string | string[], message: string, link?: string): FormResult {
  for (const p of Array.isArray(path) ? path : [path]) revalidatePath(p);
  return link ? { ok: true, message, link } : { ok: true, message };
}
async function inviteLink(token: string): Promise<string> {
  const h = await headers();
  const base = process.env.NEXT_PUBLIC_APP_URL || `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  return `${base.replace(/\/$/, "")}/invite/${token}`;
}

// ── clinic details, bill header, operating settings ──────────────────────────
export async function saveClinicProfile(fd: FormData): Promise<FormResult> {
  const ctx = await guard("settings.change", "manage_settings", "/admin/settings");
  const row = {
    name: s(fd, "name"), legal_name: opt(fd, "legal_name"), pan_number: opt(fd, "pan_number"), registration_no: opt(fd, "registration_no"),
    phone: opt(fd, "phone"), email: opt(fd, "email")?.toLowerCase() ?? null, address_province: opt(fd, "address_province"),
    address_district: opt(fd, "address_district"), address_municipality: opt(fd, "address_municipality"),
    address_ward: opt(fd, "address_ward"), address_street: opt(fd, "address_street"),
  };
  if (row.name.length < 2) return { ok: false, error: "Enter the clinic's name." };
  if (row.pan_number && !/^\d{9}$/.test(row.pan_number)) return { ok: false, error: "PAN is 9 digits." };
  if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) return { ok: false, error: "Enter a valid email address." };
  const { error } = await serviceClient().from("tenants").update(row).eq("id", ctx.tenantId);
  if (error) return { ok: false, error: friendly(error) };
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: "tenant.profile_update", targetType: "tenant", targetId: ctx.tenantId });
  return done(["/admin/settings", "/admin"], "Clinic details saved.");
}

export async function saveBillingProfile(fd: FormData): Promise<FormResult> {
  const ctx = await guard("settings.change", "manage_settings", "/admin/settings");
  const row = {
    legal_name: s(fd, "legal_name"), pan_vat_no: opt(fd, "pan_vat_no"), registration_no: opt(fd, "registration_no"),
    address: opt(fd, "address"), phone: opt(fd, "phone"), invoice_prefix: s(fd, "invoice_prefix").toUpperCase(), receipt_footer: opt(fd, "receipt_footer"),
  };
  if (row.legal_name.length < 2) return { ok: false, error: "Enter the legal name printed on bills." };
  if (row.pan_vat_no && !/^\d{9}$/.test(row.pan_vat_no)) return { ok: false, error: "PAN/VAT number is 9 digits." };
  if (!/^[A-Z0-9-]{0,12}$/.test(row.invoice_prefix)) return { ok: false, error: "Bill prefix: up to 12 letters, numbers or hyphens." };
  const { data, error } = await serviceClient().from("billing_profiles").update(row).eq("tenant_id", ctx.tenantId).eq("is_default", true).select("id");
  if (error) return { ok: false, error: friendly(error) };
  if (!data?.length) return { ok: false, error: "This clinic has no default billing profile. Contact CMediSewa support." };
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: "billing_profile.update", targetType: "billing_profile", targetId: (data[0] as { id: string }).id });
  return done(["/admin/settings", "/admin"], "Bill header saved.");
}

const SETTING_RULES: Record<string, [number, number]> = {
  booking_window_days: [1, 365], min_notice_minutes: [0, 10080], cancellation_cutoff_hours: [0, 168],
  idle_lock_minutes: [1, 240], shift_window_hours: [1, 24], near_expiry_days: [1, 730], critical_expiry_days: [0, 365],
};
export async function saveOperatingSettings(fd: FormData): Promise<FormResult> {
  const ctx = await guard("settings.change", "manage_settings", "/admin/settings");
  const row: Record<string, unknown> = {};
  for (const [k, [min, max]] of Object.entries(SETTING_RULES)) {
    const v = num(fd, k);
    if (v === null || !Number.isInteger(v) || v < min || v > max) return { ok: false, error: `${k.replaceAll("_", " ")} must be between ${min} and ${max}.` };
    row[k] = v;
  }
  if ((row.critical_expiry_days as number) > (row.near_expiry_days as number)) return { ok: false, error: "Critical expiry days can't be more than near-expiry days." };
  const pick = (k: string, allowed: string[]) => (allowed.includes(s(fd, k)) ? s(fd, k) : null);
  row.scheduling_mode = pick("scheduling_mode", ["slot", "token", "both"]);
  row.consultation_billing_point = pick("consultation_billing_point", ["check_in", "checkout", "none"]);
  row.pin_policy = pick("pin_policy", ["off", "allowed", "required"]);
  row.print_paper_width = pick("print_paper_width", ["58mm", "80mm", "a5", "a4"]);
  if (Object.values(row).includes(null)) return { ok: false, error: "Choose a value for every option." };
  row.auto_confirm_online = on(fd, "auto_confirm_online");
  const { error } = await serviceClient().from("tenant_settings").update(row).eq("tenant_id", ctx.tenantId);
  if (error) return { ok: false, error: friendly(error) };
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: "settings.update", targetType: "tenant_settings", targetId: ctx.tenantId, detail: row });
  return done("/admin/settings", "Settings saved.");
}

// ── departments & services ────────────────────────────────────────────────────
export async function saveDepartment(fd: FormData): Promise<FormResult> {
  const ctx = await guard("admin.area", "manage_catalogue", "/admin/services");
  const id = s(fd, "id");
  const row = { name: s(fd, "name"), description: opt(fd, "description"), is_active: id ? on(fd, "is_active") : true, sort_order: num(fd, "sort_order") ?? 0 };
  if (row.name.length < 2) return { ok: false, error: "Enter a department name." };
  const db = serviceClient();
  const { error } = id
    ? await db.from("departments").update(row).eq("tenant_id", ctx.tenantId).eq("id", id)
    : await db.from("departments").insert({ ...row, tenant_id: ctx.tenantId });
  if (error) return { ok: false, error: friendly(error) };
  return done(["/admin/services", "/admin/doctors"], id ? "Department saved." : "Department added.");
}

const SERVICE_KINDS = ["consultation", "procedure", "lab", "other"];
export async function saveService(fd: FormData): Promise<FormResult> {
  const ctx = await guard("admin.area", "manage_catalogue", "/admin/services");
  const id = s(fd, "id");
  const row = {
    name: s(fd, "name"), kind: s(fd, "kind"), department_id: opt(fd, "department_id"), price_npr: num(fd, "price_npr"),
    duration_minutes: num(fd, "duration_minutes"), is_public: on(fd, "is_public"), is_active: id ? on(fd, "is_active") : true,
  };
  if (row.name.length < 2) return { ok: false, error: "Enter a service name." };
  if (!SERVICE_KINDS.includes(row.kind)) return { ok: false, error: "Choose what kind of service this is." };
  if (row.price_npr === null || !Number.isFinite(row.price_npr) || row.price_npr < 0) return { ok: false, error: "Enter a price of zero or more." };
  if (row.department_id && !UUID.test(row.department_id)) return { ok: false, error: "Choose a department." };
  const db = serviceClient();
  const { error } = id
    ? await db.from("services").update(row).eq("tenant_id", ctx.tenantId).eq("id", id)
    : await db.from("services").insert({ ...row, tenant_id: ctx.tenantId });
  if (error) return { ok: false, error: /foreign key/.test(error.message) ? "Choose a department of this clinic." : friendly(error) };
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: id ? "service.update" : "service.create", targetType: "service", targetId: id || undefined, detail: { name: row.name, price_npr: row.price_npr } });
  return done(["/admin/services", "/admin"], id ? "Service saved." : "Service added.");
}

// ── doctors & schedules ──────────────────────────────────────────────────────
export async function saveDoctor(fd: FormData): Promise<FormResult> {
  const ctx = await guard("admin.area", "manage_catalogue", "/admin/doctors");
  const memberId = s(fd, "member_id");
  if (!UUID.test(memberId)) return { ok: false, error: "Choose a staff member." };
  const fee = num(fd, "consultation_fee");
  if (fee !== null && (!Number.isFinite(fee) || fee < 0)) return { ok: false, error: "Fee must be zero or more." };
  const bio = opt(fd, "bio");
  if (bio && bio.length > 1500) return { ok: false, error: "Keep the bio under 1,500 characters." };
  const db = serviceClient();
  const { error } = await db.from("doctor_profiles").upsert({
    tenant_id: ctx.tenantId, member_id: memberId, specialty: opt(fd, "specialty"), qualification: opt(fd, "qualification"), bio,
    consultation_fee: fee, room: opt(fd, "room"), is_public: on(fd, "is_public"),
  }, { onConflict: "member_id" });
  if (error) return { ok: false, error: /foreign key/.test(error.message) ? "That person isn't on this clinic's staff." : friendly(error) };
  const depts = ids(fd, "department_ids");
  const del = await db.from("doctor_departments").delete().eq("tenant_id", ctx.tenantId).eq("member_id", memberId);
  if (del.error) return { ok: false, error: friendly(del.error) };
  if (depts.length) {
    const ins = await db.from("doctor_departments").insert(depts.map((d) => ({ tenant_id: ctx.tenantId, member_id: memberId, department_id: d })));
    if (ins.error) return { ok: false, error: friendly(ins.error) };
  }
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: "doctor.save", targetType: "tenant_member", targetId: memberId });
  return done(["/admin/doctors", `/admin/doctors/${memberId}`, "/admin"], "Doctor saved.");
}

function windowFields(fd: FormData): { start: string; end: string; slot_minutes: number | null; max_tokens: number | null } | string {
  const start = s(fd, "start_time"), end = s(fd, "end_time");
  if (!TIME.test(start) || !TIME.test(end)) return "Enter start and end times.";
  if (end <= start) return "The end time must be after the start time.";
  const mode = s(fd, "mode");
  if (mode === "slot") {
    const m = num(fd, "slot_minutes");
    if (!m || m < 5 || m > 240) return "Appointment length must be 5–240 minutes.";
    return { start, end, slot_minutes: m, max_tokens: null };
  }
  if (mode === "token") {
    const t = num(fd, "max_tokens");
    if (!t || t < 1 || t > 500) return "Tokens per session must be 1–500.";
    return { start, end, slot_minutes: null, max_tokens: t };
  }
  return "Choose time slots or tokens.";
}

export async function addSchedule(fd: FormData): Promise<FormResult> {
  const memberId = s(fd, "member_id");
  const ctx = await guard("admin.area", "manage_schedules", `/admin/doctors/${memberId}`);
  const days = fd.getAll("weekday").map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (!days.length) return { ok: false, error: "Choose at least one day." };
  const w = windowFields(fd);
  if (typeof w === "string") return { ok: false, error: w };
  const from = s(fd, "effective_from") || kathmanduToday();
  if (!DATE.test(from)) return { ok: false, error: "Enter a valid start date." };
  const { error } = await serviceClient().from("doctor_schedules").insert(days.map((weekday) => ({
    tenant_id: ctx.tenantId, member_id: memberId, weekday, start_time: w.start, end_time: w.end,
    slot_minutes: w.slot_minutes, max_tokens: w.max_tokens, room: opt(fd, "room"), effective_from: from,
  })));
  if (error) return { ok: false, error: /foreign key/.test(error.message) ? "Save the doctor's profile first." : friendly(error) };
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: "schedule.add", targetType: "tenant_member", targetId: memberId, detail: { days, ...w, from } });
  return done([`/admin/doctors/${memberId}`, "/admin/doctors", "/admin"], days.length > 1 ? `OPD added on ${days.length} days.` : "OPD added.");
}

/** Ends a weekly window. Past days keep their history: the window is closed yesterday rather
 *  than deleted, unless it never started. */
export async function endSchedule(fd: FormData): Promise<FormResult> {
  const memberId = s(fd, "member_id");
  const ctx = await guard("admin.area", "manage_schedules", `/admin/doctors/${memberId}`);
  const id = s(fd, "id");
  const today = kathmanduToday();
  const db = serviceClient();
  const { data: w } = await db.from("doctor_schedules").select("effective_from").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle<{ effective_from: string }>();
  if (!w) return { ok: false, error: "That OPD window was not found." };
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const { error } = w.effective_from >= today
    ? await db.from("doctor_schedules").delete().eq("tenant_id", ctx.tenantId).eq("id", id)
    : await db.from("doctor_schedules").update({ effective_to: yesterday }).eq("tenant_id", ctx.tenantId).eq("id", id);
  if (error) return { ok: false, error: friendly(error) };
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: "schedule.end", targetType: "doctor_schedule", targetId: id });
  return done([`/admin/doctors/${memberId}`, "/admin/doctors"], "OPD window removed.");
}

export async function addException(fd: FormData): Promise<FormResult> {
  const memberId = s(fd, "member_id");
  const ctx = await guard("admin.area", "manage_schedules", `/admin/doctors/${memberId}`);
  const kind = s(fd, "kind");
  const date = s(fd, "on_date");
  if (!["leave", "extra", "modified"].includes(kind)) return { ok: false, error: "Choose leave, extra OPD or changed hours." };
  if (!DATE.test(date) || date < kathmanduToday()) return { ok: false, error: "Choose today or a future date." };
  let row: Record<string, unknown> = { tenant_id: ctx.tenantId, member_id: memberId, on_date: date, kind, reason: opt(fd, "reason") };
  if (kind === "leave") {
    const start = s(fd, "start_time"), end = s(fd, "end_time");
    if (start || end) {
      if (!TIME.test(start) || !TIME.test(end) || end <= start) return { ok: false, error: "For part-day leave, enter a start and a later end time." };
      row = { ...row, start_time: start, end_time: end };
    }
  } else {
    const w = windowFields(fd);
    if (typeof w === "string") return { ok: false, error: w };
    row = { ...row, start_time: w.start, end_time: w.end, slot_minutes: w.slot_minutes, max_tokens: w.max_tokens };
  }
  const { error } = await serviceClient().from("schedule_exceptions").insert(row);
  if (error) return { ok: false, error: /foreign key/.test(error.message) ? "Save the doctor's profile first." : friendly(error) };
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: "schedule.exception_add", targetType: "tenant_member", targetId: memberId, detail: { kind, date } });
  return done([`/admin/doctors/${memberId}`], kind === "leave" ? "Leave added." : "OPD change added.");
}

export async function deleteException(fd: FormData): Promise<FormResult> {
  const memberId = s(fd, "member_id");
  const ctx = await guard("admin.area", "manage_schedules", `/admin/doctors/${memberId}`);
  const { error } = await serviceClient().from("schedule_exceptions").delete().eq("tenant_id", ctx.tenantId).eq("id", s(fd, "id"));
  if (error) return { ok: false, error: friendly(error) };
  return done([`/admin/doctors/${memberId}`], "Removed.");
}

// ── staff, roles, credentials ────────────────────────────────────────────────
const PROFESSIONS: Record<string, string> = { doctor: "NMC", nurse: "NNC", pharmacist: "NPC", lab_technician: "NHPC" };

export async function inviteStaff(fd: FormData): Promise<FormResult> {
  const ctx = await guard("staff.manage", "manage_staff", "/admin/staff");
  const name = s(fd, "display_name");
  const email = s(fd, "email").toLowerCase();
  const username = s(fd, "username").toLowerCase();
  const isAdmin = s(fd, "membership_role") === "tenant_admin";
  if (name.length < 2) return { ok: false, error: "Enter the person's name." };
  if (!email && !username) return { ok: false, error: "Give them an email or a username to sign in with." };
  if (isAdmin && !email) return { ok: false, error: "Clinic admins need an email address." };
  if (isAdmin && ctx.membershipRole !== "tenant_admin") return { ok: false, error: "Only a clinic admin can add another admin." };
  if (username && !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) return { ok: false, error: "Usernames are 3–32 lowercase letters, numbers, dots, dashes or underscores." };
  const profession = s(fd, "profession");
  const regNo = s(fd, "registration_no");
  if (profession && !PROFESSIONS[profession]) return { ok: false, error: "Choose a profession." };
  if (profession && regNo.length < 2) return { ok: false, error: "Enter their council registration number." };

  const token = newToken();
  const db = serviceClient();
  const { data: memberId, error } = await db.rpc("invite_member", {
    p_tenant: ctx.tenantId, p_display_name: name, p_email: email || null, p_username: username || null, p_title: opt(fd, "title"),
    p_membership_role: isAdmin ? "tenant_admin" : "tenant_member", p_role_ids: ids(fd, "role_ids"), p_token_hash: hmac("invite", token), p_by: ctx.memberId,
  });
  if (error) return { ok: false, error: /foreign key/.test(error.message) ? "Choose roles of this clinic." : friendly(error) };
  if (profession) {
    const c = await db.from("member_credentials").insert({
      tenant_id: ctx.tenantId, member_id: memberId as string, profession, council: s(fd, "council") || PROFESSIONS[profession]!, registration_no: regNo,
    });
    if (c.error) return { ok: true, message: `Invited, but the registration number was not saved: ${friendly(c.error)} Add it from their row.`, link: await inviteLink(token) };
  }
  return done("/admin/staff", `${name} invited. Share this one-time link with them (valid 7 days, shown only now):`, await inviteLink(token));
}

export async function reissueStaffInvite(fd: FormData): Promise<FormResult> {
  const ctx = await guard("staff.manage", "manage_staff", "/admin/staff");
  const token = newToken();
  const { error } = await serviceClient().rpc("reissue_member_invite", { p_tenant: ctx.tenantId, p_member: s(fd, "member_id"), p_token_hash: hmac("invite", token), p_by: ctx.memberId });
  if (error) return { ok: false, error: friendly(error) };
  return done("/admin/staff", "New invite link (the old one no longer works):", await inviteLink(token));
}

export async function setStaffRoles(fd: FormData): Promise<FormResult> {
  const ctx = await guard("staff.manage", "manage_staff", "/admin/staff");
  const { error } = await serviceClient().rpc("set_member_roles", { p_tenant: ctx.tenantId, p_member: s(fd, "member_id"), p_role_ids: ids(fd, "role_ids"), p_by: ctx.memberId });
  if (error) return { ok: false, error: /foreign key/.test(error.message) ? "Choose roles of this clinic." : friendly(error) };
  return done("/admin/staff", "Roles saved. They apply from the person's next page load.");
}

export async function setStaffActive(fd: FormData): Promise<FormResult> {
  const ctx = await guard("staff.manage", "manage_staff", "/admin/staff");
  const memberId = s(fd, "member_id");
  const active = s(fd, "active") === "true";
  if (!active && memberId === ctx.memberId) return { ok: false, error: "You can't deactivate yourself." };
  const { error } = await serviceClient().rpc("set_member_active", { p_tenant: ctx.tenantId, p_member: memberId, p_active: active, p_by: ctx.memberId });
  if (error) return { ok: false, error: friendly(error) };
  return done("/admin/staff", active ? "Reactivated." : "Deactivated. They are signed out of the clinic now.");
}

export async function addCredential(fd: FormData): Promise<FormResult> {
  const ctx = await guard("staff.manage", "manage_staff", "/admin/staff");
  const profession = s(fd, "profession");
  if (!PROFESSIONS[profession]) return { ok: false, error: "Choose a profession." };
  const regNo = s(fd, "registration_no");
  if (regNo.length < 2) return { ok: false, error: "Enter the registration number." };
  const expires = opt(fd, "expires_on");
  if (expires && !DATE.test(expires)) return { ok: false, error: "Enter a valid expiry date." };
  const { error } = await serviceClient().from("member_credentials").insert({
    tenant_id: ctx.tenantId, member_id: s(fd, "member_id"), profession, council: s(fd, "council") || PROFESSIONS[profession]!, registration_no: regNo, expires_on: expires,
  });
  if (error) return { ok: false, error: /foreign key/.test(error.message) ? "That person isn't on this clinic's staff." : friendly(error) };
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: "member.credential_add", targetType: "tenant_member", targetId: s(fd, "member_id"), detail: { profession } });
  return done(["/admin/staff", "/admin/doctors"], "Registration added. Another admin or CMediSewa must verify it.");
}

/** P-30: verified by a clinic admin who is not the holder (or by the platform admin). */
export async function verifyCredential(fd: FormData): Promise<FormResult> {
  const ctx = await guard("staff.manage", "manage_staff", "/admin/staff");
  const id = s(fd, "credential_id");
  const db = serviceClient();
  const { data: c } = await db.from("member_credentials").select("id").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
  if (!c) return { ok: false, error: "That registration was not found at this clinic." };
  const { error } = await db.rpc("verify_member_credential", { p_credential: id, p_verifier_member: ctx.memberId, p_verifier_platform_admin: null });
  if (error) return { ok: false, error: friendly(error) };
  return done(["/admin/staff", "/admin/doctors", "/admin"], "Verified.");
}

const HOME_ROUTES = ["/employee/registrar", "/employee/opd", "/employee/pharmacy", "/employee/lab", "/admin"];
export async function saveRole(fd: FormData): Promise<FormResult> {
  const ctx = await guard("staff.manage", "manage_staff", "/admin/staff");
  const name = s(fd, "name");
  if (name.length < 2) return { ok: false, error: "Give the role a name." };
  const home = s(fd, "home_route");
  if (!HOME_ROUTES.includes(home)) return { ok: false, error: "Choose the screen this role opens on." };
  const perms = fd.getAll("permissions").map(String).filter((p): p is Permission => (PERMISSION_KEYS as string[]).includes(p));
  const id = s(fd, "id");
  // Clinical keys are allowed on a role but only take effect for holders of the matching
  // verified profession (effective_permissions, D-06): say so instead of failing silently.
  const clinical = perms.filter((p) => isClinical(p));
  const { error } = await serviceClient().rpc("save_role", {
    p_tenant: ctx.tenantId, p_role: id || null, p_name: name, p_description: opt(fd, "description"), p_permissions: perms, p_home_route: home, p_by: ctx.memberId,
  });
  if (error) return { ok: false, error: friendly(error) };
  return done("/admin/staff", `Role saved.${clinical.length ? " Clinical permissions apply only to staff with a verified registration." : ""}`);
}

// ── clinic website ───────────────────────────────────────────────────────────
export async function saveWebsite(fd: FormData): Promise<FormResult> {
  const ctx = await guard("admin.area", "manage_website", "/admin/website");
  const color = s(fd, "theme_color") || "#0f5c4d";
  const mapUrl = opt(fd, "map_url");
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return { ok: false, error: "Choose a colour." };
  if (mapUrl && !/^https:\/\//.test(mapUrl)) return { ok: false, error: "The map link must start with https://" };
  const limits: [string, number][] = [["hero_title", 120], ["hero_subtitle", 240], ["about_md", 4000], ["hours_text", 300], ["seo_title", 70], ["seo_description", 170]];
  for (const [k, max] of limits) if (s(fd, k).length > max) return { ok: false, error: `${k.replace("_md", "").replaceAll("_", " ")} is too long (max ${max}).` };
  const publish = on(fd, "published");
  const db = serviceClient();
  const { data: before } = await db.from("site_settings").select("published").eq("tenant_id", ctx.tenantId).maybeSingle<{ published: boolean }>();
  const { error } = await db.from("site_settings").upsert({
    tenant_id: ctx.tenantId, published: publish, theme_color: color, hero_title: opt(fd, "hero_title"), hero_subtitle: opt(fd, "hero_subtitle"),
    about_md: opt(fd, "about_md"), contact_phone: opt(fd, "contact_phone"), contact_email: opt(fd, "contact_email"), whatsapp: opt(fd, "whatsapp"),
    map_url: mapUrl, hours_text: opt(fd, "hours_text"), seo_title: opt(fd, "seo_title"), seo_description: opt(fd, "seo_description"),
    show_prices: on(fd, "show_prices"), show_registration_numbers: on(fd, "show_registration_numbers"),
    published_at: publish && !before?.published ? new Date().toISOString() : undefined, updated_by: ctx.memberId,
  }, { onConflict: "tenant_id" });
  if (error) return { ok: false, error: friendly(error) };
  if (publish !== Boolean(before?.published)) {
    await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: publish ? "website.publish" : "website.unpublish", targetType: "tenant", targetId: ctx.tenantId });
  }
  revalidatePath(`/c/${ctx.tenantSlug}`);
  const live = ctx.tenantStatus === "active";
  return done(["/admin/website", "/admin"], publish ? (live ? "Saved and published." : "Saved. The website goes public when the clinic goes live.") : "Saved (not published).");
}

export async function addAnnouncement(fd: FormData): Promise<FormResult> {
  const ctx = await guard("admin.area", "manage_website", "/admin/website");
  const title = s(fd, "title");
  if (title.length < 2) return { ok: false, error: "Give the notice a title." };
  const ends = opt(fd, "ends_on");
  if (ends && !DATE.test(ends)) return { ok: false, error: "Enter a valid end date." };
  const { error } = await serviceClient().from("site_announcements").insert({
    tenant_id: ctx.tenantId, title, body_md: opt(fd, "body_md"), is_pinned: on(fd, "is_pinned"), ends_at: ends ? `${ends}T23:59:59+05:45` : null,
  });
  if (error) return { ok: false, error: friendly(error) };
  revalidatePath(`/c/${ctx.tenantSlug}`);
  return done("/admin/website", "Notice added.");
}

export async function addFaq(fd: FormData): Promise<FormResult> {
  const ctx = await guard("admin.area", "manage_website", "/admin/website");
  const question = s(fd, "question"), answer = s(fd, "answer_md");
  if (question.length < 3 || answer.length < 1) return { ok: false, error: "Enter a question and its answer." };
  const { error } = await serviceClient().from("site_faqs").insert({ tenant_id: ctx.tenantId, question, answer_md: answer, sort_order: num(fd, "sort_order") ?? 0 });
  if (error) return { ok: false, error: friendly(error) };
  revalidatePath(`/c/${ctx.tenantSlug}`);
  return done("/admin/website", "Question added.");
}

export async function deleteSiteItem(fd: FormData): Promise<FormResult> {
  const ctx = await guard("admin.area", "manage_website", "/admin/website");
  const table = s(fd, "type") === "faq" ? "site_faqs" : "site_announcements";
  const { error } = await serviceClient().from(table).delete().eq("tenant_id", ctx.tenantId).eq("id", s(fd, "id"));
  if (error) return { ok: false, error: friendly(error) };
  revalidatePath(`/c/${ctx.tenantSlug}`);
  return done("/admin/website", "Removed.");
}

// ── go live (W-02) ───────────────────────────────────────────────────────────
export async function goLive(): Promise<FormResult> {
  const ctx = await guard("settings.change", "manage_settings", "/admin");
  if (ctx.membershipRole !== "tenant_admin") return { ok: false, error: "Only a clinic admin can take the clinic live." };
  const { data, error } = await serviceClient().rpc("go_live", { p_tenant: ctx.tenantId, p_by: ctx.memberId });
  if (error) return { ok: false, error: friendly(error) };
  const blockers = (data ?? []) as string[];
  if (blockers.length) return { ok: false, error: `Not yet: ${blockers.map((b) => BLOCKER_LABELS[b]?.label ?? b).join("; ")}.` };
  revalidatePath(`/c/${ctx.tenantSlug}`);
  return done(["/admin", "/admin/website"], "Your clinic is live.");
}
