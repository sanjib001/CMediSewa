import "server-only";
import { serviceClient } from "@/lib/supabase/service";
import { isoDate, localDate } from "@/lib/clinic-time";

// Read side of the front desk and OPD queue (B4a). Every query is scoped by the tenant id
// from requireTenant(); joins happen here (composite FKs make PostgREST embedding ambiguous).

function rows<T>(r: { data: unknown; error: { message: string } | null }, what: string): T[] {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r.data ?? []) as T[];
}

export const todayIn = (tz = "Asia/Kathmandu") => isoDate(localDate(new Date(), tz));

export type DeskDoctor = { id: string; name: string; specialty: string | null; room: string | null; fee: number | null };
export type DeskService = { id: string; name: string; kind: string; price: number; taxCategory: string };
export type DeskSettings = { billingPoint: "check_in" | "checkout" | "none"; allowCredit: boolean; maxDiscountPct: number };

export async function getDeskSetup(tenantId: string) {
  const db = serviceClient();
  const [d, m, s, st] = await Promise.all([
    db.from("doctor_profiles").select("member_id, specialty, room, consultation_fee").eq("tenant_id", tenantId),
    db.from("tenant_members").select("id, display_name, is_active").eq("tenant_id", tenantId),
    db.from("services").select("id, name, kind, price_npr, tax_category").eq("tenant_id", tenantId).eq("is_active", true).order("kind").order("name"),
    db.from("tenant_settings").select("consultation_billing_point, allow_credit, max_discount_pct_without_reauth").eq("tenant_id", tenantId).single(),
  ]);
  const members = rows<{ id: string; display_name: string; is_active: boolean }>(m, "members");
  const doctors: DeskDoctor[] = rows<{ member_id: string; specialty: string | null; room: string | null; consultation_fee: number | null }>(d, "doctors")
    .map((x) => ({ id: x.member_id, member: members.find((y) => y.id === x.member_id), specialty: x.specialty, room: x.room, fee: x.consultation_fee === null ? null : Number(x.consultation_fee) }))
    .filter((x) => x.member?.is_active)
    .map(({ member, ...x }) => ({ ...x, name: member!.display_name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const services: DeskService[] = rows<{ id: string; name: string; kind: string; price_npr: number; tax_category: string }>(s, "services")
    .map((x) => ({ id: x.id, name: x.name, kind: x.kind, price: Number(x.price_npr), taxCategory: x.tax_category }));
  if (st.error) throw new Error(`settings: ${st.error.message}`);
  const set = st.data as { consultation_billing_point: DeskSettings["billingPoint"]; allow_credit: boolean; max_discount_pct_without_reauth: number };
  return { doctors, services, settings: { billingPoint: set.consultation_billing_point, allowCredit: set.allow_credit, maxDiscountPct: Number(set.max_discount_pct_without_reauth) } as DeskSettings };
}

export type PatientLite = { id: string; mrn: string; full_name: string; sex: string; age: string; phone: string | null; possible_duplicate: boolean };
export function ageText(dob: string | null, ageYears: number | null, createdAt?: string): string {
  if (dob) {
    const b = new Date(`${dob}T00:00:00Z`), n = new Date();
    let y = n.getUTCFullYear() - b.getUTCFullYear();
    if (n.getUTCMonth() < b.getUTCMonth() || (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate())) y--;
    return y >= 1 ? `${y}y` : `${Math.max(0, Math.floor((n.getTime() - b.getTime()) / (30.44 * 86_400_000)))}m`;
  }
  if (ageYears === null) return "";
  // Age given at registration grows with time.
  const years = createdAt ? ageYears + Math.floor((Date.now() - Date.parse(createdAt)) / (365.25 * 86_400_000)) : ageYears;
  return `${years}y`;
}
type PatientRow = { id: string; mrn: string; full_name: string; sex: string; date_of_birth: string | null; age_years: number | null; phone: string | null; possible_duplicate: boolean; created_at: string };
export const toLite = (p: PatientRow): PatientLite => ({
  id: p.id, mrn: p.mrn, full_name: p.full_name, sex: p.sex, age: ageText(p.date_of_birth, p.age_years, p.created_at), phone: p.phone, possible_duplicate: p.possible_duplicate,
});

export type QueueVisit = {
  id: string; token: number; status: string; doctorId: string; patient: PatientLite; checkedInAt: string; calledAt: string | null;
  appointmentId: string | null; invoiceNo: string | null; total: number | null; paid: number | null;
};
export type TodayAppointment = {
  id: string; doctorId: string; patient: PatientLite; start: string; end: string; mode: string; status: string; source: string; reason: string | null;
};

export async function getToday(tenantId: string, date: string, onlyDoctor?: string) {
  const db = serviceClient();
  let vq = db.from("visits").select("id, token_no, status, doctor_member_id, patient_id, checked_in_at, called_at, appointment_id").eq("tenant_id", tenantId).eq("visit_date", date).order("token_no");
  // Website requests without a patient yet are listed separately (listBookingRequests).
  let aq = db.from("appointments").select("id, doctor_member_id, patient_id, scheduled_range, mode, status, source, reason_for_visit").eq("tenant_id", tenantId).eq("appointment_date", date).not("patient_id", "is", null);
  if (onlyDoctor) { vq = vq.eq("doctor_member_id", onlyDoctor); aq = aq.eq("doctor_member_id", onlyDoctor); }
  const [v, a] = await Promise.all([vq, aq]);
  const visits = rows<{ id: string; token_no: number; status: string; doctor_member_id: string; patient_id: string; checked_in_at: string; called_at: string | null; appointment_id: string | null }>(v, "visits");
  const appts = rows<{ id: string; doctor_member_id: string; patient_id: string; scheduled_range: string; mode: string; status: string; source: string; reason_for_visit: string | null }>(a, "appointments");
  const pids = [...new Set([...visits.map((x) => x.patient_id), ...appts.map((x) => x.patient_id)])];
  const vids = visits.map((x) => x.id);
  const [p, inv] = await Promise.all([
    pids.length ? db.from("patients").select("id, mrn, full_name, sex, date_of_birth, age_years, phone, possible_duplicate, created_at").eq("tenant_id", tenantId).in("id", pids) : Promise.resolve({ data: [], error: null }),
    vids.length ? db.from("invoices").select("id, visit_id, invoice_no, total").eq("tenant_id", tenantId).in("visit_id", vids) : Promise.resolve({ data: [], error: null }),
  ]);
  const patients = new Map(rows<PatientRow>(p, "patients").map((x) => [x.id, toLite(x)]));
  const invoices = rows<{ id: string; visit_id: string; invoice_no: string; total: number }>(inv, "invoices");
  const allocs = invoices.length
    ? rows<{ invoice_id: string; amount: number }>(await db.from("payment_allocations").select("invoice_id, amount").eq("tenant_id", tenantId).in("invoice_id", invoices.map((i) => i.id)), "allocations")
    : [];
  const range = (r: string) => { const m = r.match(/^[[(]"?([^",]+)"?,"?([^",\])]+)"?[\])]$/); return m ? [new Date(m[1]!).toISOString(), new Date(m[2]!).toISOString()] : [r, r]; };
  return {
    visits: visits.map((x): QueueVisit => {
      const i = invoices.find((y) => y.visit_id === x.id);
      return {
        id: x.id, token: x.token_no, status: x.status, doctorId: x.doctor_member_id, patient: patients.get(x.patient_id)!, checkedInAt: x.checked_in_at,
        calledAt: x.called_at, appointmentId: x.appointment_id, invoiceNo: i?.invoice_no ?? null, total: i ? Number(i.total) : null,
        paid: i ? allocs.filter((z) => z.invoice_id === i.id).reduce((s, z) => s + Number(z.amount), 0) : null,
      };
    }),
    appointments: appts.map((x): TodayAppointment => {
      const [start, end] = range(x.scheduled_range);
      return { id: x.id, doctorId: x.doctor_member_id, patient: patients.get(x.patient_id)!, start: start!, end: end!, mode: x.mode, status: x.status, source: x.source, reason: x.reason_for_visit };
    }).sort((a, b) => a.start.localeCompare(b.start)),
  };
}


// ── website booking requests (B4c, D-82) ─────────────────────────────────────
export type BookingRequest = {
  id: string; doctorId: string; doctorName: string; start: string; end: string; mode: string; createdAt: string;
  name: string; phone: string | null; email: string | null; age: number | null; sex: string | null; reason: string | null;
  matches: PatientLite[];
};
/** Open requests, oldest time first, each with existing patients matching its phone number. */
export async function listBookingRequests(tenantId: string): Promise<BookingRequest[]> {
  const db = serviceClient();
  await db.rpc("expire_booking_requests", { p_tenant: tenantId });
  const { data, error } = await db.from("appointments")
    .select("id, doctor_member_id, scheduled_range, mode, created_at, requester_name, requester_phone, requester_email, requester_age, requester_sex, reason_for_visit")
    .eq("tenant_id", tenantId).eq("status", "requested").order("appointment_date").limit(200);
  if (error) throw new Error(`requests: ${error.message}`);
  const rowsR = (data ?? []) as { id: string; doctor_member_id: string; scheduled_range: string; mode: string; created_at: string; requester_name: string;
    requester_phone: string | null; requester_email: string | null; requester_age: number | null; requester_sex: string | null; reason_for_visit: string | null }[];
  if (!rowsR.length) return [];
  const docIds = [...new Set(rowsR.map((r) => r.doctor_member_id))];
  const { data: docs } = await db.from("tenant_members").select("id, display_name").eq("tenant_id", tenantId).in("id", docIds);
  const digits = [...new Set(rowsR.map((r) => (r.requester_phone ?? "").replace(/\D/g, "")).filter((d) => d.length >= 7))];
  const { data: pats } = digits.length
    ? await db.from("patients").select("id, mrn, full_name, sex, date_of_birth, age_years, phone, phone_digits, possible_duplicate, created_at").eq("tenant_id", tenantId).is("deleted_at", null).in("phone_digits", digits)
    : { data: [] };
  const range = (r: string) => { const m = r.match(/^[[(]"?([^",]+)"?,"?([^",\])]+)"?[\])]$/); return m ? [new Date(m[1]!).toISOString(), new Date(m[2]!).toISOString()] : [r, r]; };
  return rowsR.map((r) => {
    const [start, end] = range(r.scheduled_range);
    const d = (r.requester_phone ?? "").replace(/\D/g, "");
    return {
      id: r.id, doctorId: r.doctor_member_id, doctorName: ((docs ?? []) as { id: string; display_name: string }[]).find((x) => x.id === r.doctor_member_id)?.display_name ?? "",
      start: start!, end: end!, mode: r.mode, createdAt: r.created_at, name: r.requester_name, phone: r.requester_phone, email: r.requester_email,
      age: r.requester_age, sex: r.requester_sex, reason: r.reason_for_visit,
      matches: ((pats ?? []) as (Parameters<typeof toLite>[0] & { phone_digits: string })[]).filter((p) => d && p.phone_digits === d).map(toLite),
    };
  }).sort((a, b) => a.start.localeCompare(b.start));
}
