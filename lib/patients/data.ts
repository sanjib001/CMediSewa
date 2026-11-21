import "server-only";
import { serviceClient } from "@/lib/supabase/service";
import { ageText, toLite, type PatientLite } from "@/lib/desk/data";

// Patients (U3b): the clinic's patient register and one patient's non-clinical record. Chart
// content (notes, diagnoses, prescriptions) stays behind the clinical functions (C1–C6).

const rows = <T,>(r: { data: unknown; error: { message: string } | null }, what: string): T[] => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r.data ?? []) as T[];
};
const COLS = "id, mrn, full_name, sex, date_of_birth, age_years, phone, possible_duplicate, created_at";

export async function listPatients(tenantId: string, q: string, flagged: boolean): Promise<PatientLite[]> {
  const db = serviceClient();
  const term = q.trim().slice(0, 60);
  if (term && !flagged) return rows<Parameters<typeof toLite>[0]>(await db.rpc("search_patients", { p_tenant: tenantId, p_q: term, p_limit: 50 }), "search").map(toLite);
  let qq = db.from("patients").select(COLS).eq("tenant_id", tenantId).is("deleted_at", null).order("created_at", { ascending: false }).limit(50);
  if (flagged) qq = qq.eq("possible_duplicate", true);
  return rows<Parameters<typeof toLite>[0]>(await qq, "patients").map(toLite);
}

export async function patientCounts(tenantId: string) {
  const db = serviceClient();
  const [all, dup] = await Promise.all([
    db.from("patients").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).is("deleted_at", null),
    db.from("patients").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).is("deleted_at", null).eq("possible_duplicate", true),
  ]);
  return { total: all.count ?? 0, flagged: dup.count ?? 0 };
}

export type PatientRecord = {
  id: string; mrn: string; full_name: string; full_name_ne: string | null; sex: string; date_of_birth: string | null; age_years: number | null; age: string;
  phone: string | null; alt_phone: string | null; email: string | null; address: string | null; guardian_name: string | null; guardian_relation: string | null;
  blood_group: string | null; created_via: string; possible_duplicate: boolean; created_at: string;
  visits: { id: string; date: string; token: number; doctor: string; status: string }[];
  appointments: { id: string; at: string; doctor: string; status: string; source: string }[];
  bills: { id: string; invoice_no: string; at: string; total: number; owed: number; status: string; source: string }[];
  owed: number;
  candidates: { id: string; mrn: string; full_name: string; age: string; phone: string | null; why: string }[];
};

export async function getPatient(tenantId: string, id: string): Promise<PatientRecord | null> {
  const db = serviceClient();
  const { data: p } = await db.from("patients").select("*").eq("tenant_id", tenantId).eq("id", id).is("deleted_at", null).maybeSingle();
  if (!p) return null;
  const [v, a, inv, open, cand, docs] = await Promise.all([
    db.from("visits").select("id, visit_date, token_no, doctor_member_id, status").eq("tenant_id", tenantId).eq("patient_id", id).order("visit_date", { ascending: false }).limit(30),
    db.from("appointments").select("id, scheduled_range, doctor_member_id, status, source").eq("tenant_id", tenantId).eq("patient_id", id).order("appointment_date", { ascending: false }).limit(30),
    db.from("invoices").select("id, invoice_no, issued_at, total, status, source").eq("tenant_id", tenantId).eq("patient_id", id).order("issued_at", { ascending: false }).limit(50),
    db.rpc("patient_open_bills", { p_tenant: tenantId, p_patient: id }),
    p.possible_duplicate ? db.rpc("patient_duplicate_candidates", { p_tenant: tenantId, p_patient: id }) : Promise.resolve({ data: [], error: null }),
    db.from("tenant_members").select("id, display_name").eq("tenant_id", tenantId),
  ]);
  const name = new Map(rows<{ id: string; display_name: string }>(docs, "members").map((m) => [m.id, m.display_name]));
  const owedBy = new Map(rows<{ invoice_id: string; outstanding: number }>(open, "open bills").map((o) => [o.invoice_id, Number(o.outstanding)]));
  return {
    id: p.id, mrn: p.mrn, full_name: p.full_name, full_name_ne: p.full_name_ne, sex: p.sex, date_of_birth: p.date_of_birth, age_years: p.age_years,
    age: ageText(p.date_of_birth, p.age_years, p.created_at), phone: p.phone, alt_phone: p.alt_phone, email: p.email, address: p.address,
    guardian_name: p.guardian_name, guardian_relation: p.guardian_relation, blood_group: p.blood_group, created_via: p.created_via,
    possible_duplicate: p.possible_duplicate, created_at: p.created_at,
    visits: rows<{ id: string; visit_date: string; token_no: number; doctor_member_id: string; status: string }>(v, "visits")
      .map((x) => ({ id: x.id, date: x.visit_date, token: x.token_no, doctor: name.get(x.doctor_member_id) ?? "", status: x.status })),
    appointments: rows<{ id: string; scheduled_range: string; doctor_member_id: string; status: string; source: string }>(a, "appointments")
      .map((x) => ({ id: x.id, at: /^[[(]"?([^",]+)/.exec(x.scheduled_range)?.[1] ?? "", doctor: name.get(x.doctor_member_id) ?? "", status: x.status, source: x.source })),
    bills: rows<{ id: string; invoice_no: string; issued_at: string; total: number; status: string; source: string }>(inv, "bills")
      .map((x) => ({ id: x.id, invoice_no: x.invoice_no, at: x.issued_at, total: Number(x.total), owed: owedBy.get(x.id) ?? 0, status: x.status, source: x.source })),
    owed: Math.round([...owedBy.values()].reduce((s, n) => s + n, 0) * 100) / 100,
    candidates: rows<{ id: string; mrn: string; full_name: string; date_of_birth: string | null; age_years: number | null; phone: string | null; created_at: string; why: string }>(cand, "candidates")
      .map((x) => ({ id: x.id, mrn: x.mrn, full_name: x.full_name, age: ageText(x.date_of_birth, x.age_years, x.created_at), phone: x.phone, why: x.why })),
  };
}
