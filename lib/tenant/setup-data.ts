import "server-only";
import { serviceClient } from "@/lib/supabase/service";

// Read side of clinic setup (B3). Every query is scoped by the caller's tenant id, which comes
// from requireTenant(), never from the request. Joins are done here rather than through
// PostgREST embedding, because composite foreign keys make embedding ambiguous.

function rows<T>(r: { data: unknown; error: { message: string } | null }, what: string): T[] {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r.data ?? []) as T[];
}
function one<T>(r: { data: unknown; error: { message: string } | null }, what: string): T | null {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r.data ?? null) as T | null;
}

export type Clinic = {
  id: string; slug: string; name: string; legal_name: string | null; pan_number: string | null; registration_no: string | null;
  phone: string | null; email: string | null; address_province: string | null; address_district: string | null;
  address_municipality: string | null; address_ward: string | null; address_street: string | null; status: string;
};
export type BillingProfile = {
  id: string; name: string; legal_name: string; pan_vat_no: string | null; registration_no: string | null; address: string | null;
  phone: string | null; invoice_prefix: string; receipt_footer: string | null;
};
export type Settings = {
  booking_window_days: number; min_notice_minutes: number; cancellation_cutoff_hours: number; auto_confirm_online: boolean;
  scheduling_mode: string; consultation_billing_point: string; pin_policy: string; idle_lock_minutes: number;
  shift_window_hours: number; print_paper_width: string; near_expiry_days: number; critical_expiry_days: number;
  allow_credit: boolean; credit_limit_per_patient: number; max_discount_pct_without_reauth: number; reminder_hours_before: number;
  reorder_cover_days: number; po_approval_limit: number | null;
};

export async function getClinicSettings(tenantId: string) {
  const db = serviceClient();
  const [t, s, b] = await Promise.all([
    db.from("tenants").select("id, slug, name, legal_name, pan_number, registration_no, phone, email, address_province, address_district, address_municipality, address_ward, address_street, status").eq("id", tenantId).single(),
    db.from("tenant_settings").select("booking_window_days, min_notice_minutes, cancellation_cutoff_hours, auto_confirm_online, scheduling_mode, consultation_billing_point, pin_policy, idle_lock_minutes, shift_window_hours, print_paper_width, near_expiry_days, critical_expiry_days, allow_credit, credit_limit_per_patient, max_discount_pct_without_reauth, reminder_hours_before, reorder_cover_days, po_approval_limit").eq("tenant_id", tenantId).maybeSingle(),
    db.from("billing_profiles").select("id, name, legal_name, pan_vat_no, registration_no, address, phone, invoice_prefix, receipt_footer").eq("tenant_id", tenantId).eq("is_default", true).maybeSingle(),
  ]);
  return { clinic: one<Clinic>(t, "tenant")!, settings: one<Settings>(s, "settings"), billing: one<BillingProfile>(b, "billing profile") };
}

export type Department = { id: string; name: string; description: string | null; is_active: boolean; sort_order: number };
export type Service = {
  id: string; name: string; kind: string; department_id: string | null; price_npr: number; duration_minutes: number | null;
  is_public: boolean; is_active: boolean;
};
export async function listCatalogue(tenantId: string) {
  const db = serviceClient();
  const [d, s] = await Promise.all([
    db.from("departments").select("id, name, description, is_active, sort_order").eq("tenant_id", tenantId).order("sort_order").order("name"),
    db.from("services").select("id, name, kind, department_id, price_npr, duration_minutes, is_public, is_active").eq("tenant_id", tenantId).order("kind").order("name"),
  ]);
  return { departments: rows<Department>(d, "departments"), services: rows<Service>(s, "services") };
}

export type Credential = {
  id: string; member_id: string; profession: string; council: string; registration_no: string;
  verified_at: string | null; expires_on: string | null;
};
export type Role = { id: string; name: string; description: string | null; permissions: string[]; home_route: string; template_key: string | null; is_active: boolean };
export type StaffRow = {
  id: string; display_name: string; title: string | null; email: string | null; username: string | null;
  membership_role: "tenant_admin" | "tenant_member"; is_active: boolean; joined: boolean; last_active_at: string | null;
  roleIds: string[]; credentials: Credential[]; invite: { expires_at: string } | null;
};

export async function listStaff(tenantId: string) {
  const db = serviceClient();
  const [m, mr, r, c, i] = await Promise.all([
    db.from("tenant_members").select("id, display_name, title, email, username, membership_role, is_active, auth_user_id, last_active_at")
      .eq("tenant_id", tenantId).is("deleted_at", null).order("display_name"),
    db.from("member_roles").select("member_id, role_id").eq("tenant_id", tenantId),
    db.from("tenant_roles").select("id, name, description, permissions, home_route, template_key, is_active").eq("tenant_id", tenantId).order("name"),
    db.from("member_credentials").select("id, member_id, profession, council, registration_no, verified_at, expires_on").eq("tenant_id", tenantId),
    db.from("member_invites").select("member_id, expires_at, used_at, revoked_at").eq("tenant_id", tenantId).is("used_at", null).is("revoked_at", null),
  ]);
  const links = rows<{ member_id: string; role_id: string }>(mr, "member roles");
  const creds = rows<Credential>(c, "credentials");
  const invites = rows<{ member_id: string; expires_at: string }>(i, "invites");
  const staff = rows<Omit<StaffRow, "roleIds" | "credentials" | "invite" | "joined"> & { auth_user_id: string | null }>(m, "members").map(({ auth_user_id, ...x }) => ({
    ...x,
    joined: auth_user_id !== null,
    roleIds: links.filter((l) => l.member_id === x.id).map((l) => l.role_id),
    credentials: creds.filter((k) => k.member_id === x.id),
    invite: auth_user_id ? null : invites.filter((v) => v.member_id === x.id).sort((a, b) => b.expires_at.localeCompare(a.expires_at))[0] ?? null,
  })) as StaffRow[];
  return { staff, roles: rows<Role>(r, "roles") };
}

export type DoctorRow = {
  member_id: string; name: string; is_active: boolean; specialty: string | null; qualification: string | null; bio: string | null;
  consultation_fee: number | null; room: string | null; is_public: boolean; departmentIds: string[];
  credential: Credential | null; windows: number;
};
export async function listDoctors(tenantId: string): Promise<DoctorRow[]> {
  const db = serviceClient();
  const [p, m, dd, c, s] = await Promise.all([
    db.from("doctor_profiles").select("member_id, specialty, qualification, bio, consultation_fee, room, is_public").eq("tenant_id", tenantId),
    db.from("tenant_members").select("id, display_name, is_active").eq("tenant_id", tenantId),
    db.from("doctor_departments").select("member_id, department_id").eq("tenant_id", tenantId),
    db.from("member_credentials").select("id, member_id, profession, council, registration_no, verified_at, expires_on").eq("tenant_id", tenantId).eq("profession", "doctor"),
    db.from("doctor_schedules").select("member_id, effective_to").eq("tenant_id", tenantId),
  ]);
  const members = rows<{ id: string; display_name: string; is_active: boolean }>(m, "members");
  const today = new Date().toISOString().slice(0, 10);
  return rows<Omit<DoctorRow, "name" | "is_active" | "departmentIds" | "credential" | "windows">>(p, "doctors").map((d) => {
    const mem = members.find((x) => x.id === d.member_id);
    return {
      ...d,
      name: mem?.display_name ?? "?",
      is_active: mem?.is_active ?? false,
      departmentIds: rows<{ member_id: string; department_id: string }>(dd, "doctor departments").filter((x) => x.member_id === d.member_id).map((x) => x.department_id),
      credential: rows<Credential>(c, "credentials").find((x) => x.member_id === d.member_id) ?? null,
      windows: rows<{ member_id: string; effective_to: string | null }>(s, "schedules").filter((x) => x.member_id === d.member_id && (!x.effective_to || x.effective_to >= today)).length,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export type ScheduleRow = {
  id: string; weekday: number; start_time: string; end_time: string; slot_minutes: number | null; max_tokens: number | null;
  room: string | null; effective_from: string; effective_to: string | null;
};
export type ExceptionRow = {
  id: string; on_date: string; kind: "leave" | "extra" | "modified"; start_time: string | null; end_time: string | null;
  slot_minutes: number | null; max_tokens: number | null; reason: string | null;
};
const ktmDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(d);
export async function getDoctorSchedule(tenantId: string, memberId: string) {
  const db = serviceClient();
  const today = ktmDate(new Date());
  const [s, e] = await Promise.all([
    db.from("doctor_schedules").select("id, weekday, start_time, end_time, slot_minutes, max_tokens, room, effective_from, effective_to")
      .eq("tenant_id", tenantId).eq("member_id", memberId).or(`effective_to.is.null,effective_to.gte.${today}`).order("weekday").order("start_time"),
    db.from("schedule_exceptions").select("id, on_date, kind, start_time, end_time, slot_minutes, max_tokens, reason")
      .eq("tenant_id", tenantId).eq("member_id", memberId).gte("on_date", today).order("on_date"),
  ]);
  return { schedules: rows<ScheduleRow>(s, "schedules"), exceptions: rows<ExceptionRow>(e, "exceptions") };
}

export async function upcomingSlots(tenantId: string, memberId: string, days = 7) {
  const from = new Date();
  const to = new Date(from.getTime() + (days - 1) * 86_400_000);
  const { data, error } = await serviceClient().rpc("available_slots", {
    p_tenant: tenantId, p_doctor: memberId, p_from: ktmDate(from), p_to: ktmDate(to),
  });
  if (error) throw new Error(`slots: ${error.message}`);
  return (data ?? []) as { slot_start: string; slot_end: string; mode: "slot" | "token"; capacity: number; room: string | null }[];
}

export type SiteSettings = {
  published: boolean; theme_color: string; hero_title: string | null; hero_subtitle: string | null; about_md: string | null;
  contact_phone: string | null; contact_email: string | null; whatsapp: string | null; map_url: string | null; hours_text: string | null;
  seo_title: string | null; seo_description: string | null; show_prices: boolean; show_registration_numbers: boolean; booking_enabled: boolean;
};
export async function getWebsite(tenantId: string) {
  const db = serviceClient();
  const [s, a, f] = await Promise.all([
    db.from("site_settings").select("published, theme_color, hero_title, hero_subtitle, about_md, contact_phone, contact_email, whatsapp, map_url, hours_text, seo_title, seo_description, show_prices, show_registration_numbers, booking_enabled").eq("tenant_id", tenantId).maybeSingle(),
    db.from("site_announcements").select("id, title, body_md, starts_at, ends_at, is_pinned").eq("tenant_id", tenantId).order("starts_at", { ascending: false }),
    db.from("site_faqs").select("id, question, answer_md, sort_order").eq("tenant_id", tenantId).order("sort_order"),
  ]);
  return {
    site: one<SiteSettings>(s, "site settings"),
    announcements: rows<{ id: string; title: string; body_md: string | null; starts_at: string; ends_at: string | null; is_pinned: boolean }>(a, "announcements"),
    faqs: rows<{ id: string; question: string; answer_md: string; sort_order: number }>(f, "faqs"),
  };
}

/** What a clinic admin still has to do. `blockers` (from the database) gate going live. */
export const BLOCKER_LABELS: Record<string, { label: string; href: string }> = {
  clinic_phone: { label: "Add the clinic's phone number", href: "/admin/settings" },
  billing_profile: { label: "Fill in the legal name on bills", href: "/admin/settings" },
  consultation_service: { label: "Add a consultation service with its fee", href: "/admin/services" },
  doctor_with_schedule: { label: "Add a doctor with an OPD schedule", href: "/admin/doctors" },
  pharmacy_store: { label: "Keep an active pharmacy store", href: "/admin/settings" },
};

export async function getSetupStatus(tenantId: string) {
  const db = serviceClient();
  const [b, staff, unverified, site] = await Promise.all([
    db.rpc("go_live_blockers", { p_tenant: tenantId }),
    db.from("tenant_members").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("membership_role", "tenant_member").eq("is_active", true),
    db.from("member_credentials").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).is("verified_at", null),
    db.from("site_settings").select("published").eq("tenant_id", tenantId).maybeSingle(),
  ]);
  if (b.error) throw new Error(`blockers: ${b.error.message}`);
  const blockers = (b.data ?? []) as string[];
  const has = (k: string) => !blockers.includes(k);
  return {
    blockers,
    items: [
      { label: "Clinic details and bill header", done: has("clinic_phone") && has("billing_profile"), href: "/admin/settings", required: true },
      { label: "Consultation services and fees", done: has("consultation_service"), href: "/admin/services", required: true },
      { label: "Doctors and OPD schedules", done: has("doctor_with_schedule"), href: "/admin/doctors", required: true },
      { label: "Invite your staff", done: (staff.count ?? 0) > 0, href: "/admin/staff", required: false },
      { label: "Verify registration numbers", done: (staff.count ?? 0) > 0 && (unverified.count ?? 0) === 0, href: "/admin/staff", required: false },
      { label: "Publish the clinic website", done: Boolean((site.data as { published?: boolean } | null)?.published), href: "/admin/website", required: false },
    ],
  };
}
