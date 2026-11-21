import "server-only";
import { serviceClient } from "@/lib/supabase/service";

// Reading the clinic's audit log (U3, Admin → Audit log; view_audit_log). The log never holds
// clinical text (D-29): reads of a chart show who opened whose record, not what was in it.

export const AUDIT_GROUPS = {
  access: { label: "Sign-in and access", prefixes: ["auth", "member", "device", "session", "pin", "role", "credential", "invite"] },
  clinical: { label: "Patients and clinical", prefixes: ["patient", "encounter", "clinical", "vitals", "allergy", "prescription", "visit", "appointment", "booking"] },
  money: { label: "Money", prefixes: ["invoice", "payment", "dues", "expense", "income", "other_income", "finance", "report"] },
  stock: { label: "Stock and purchasing", prefixes: ["stock", "transfer", "batch", "item", "store", "purchase", "po", "vendor", "pharmacy", "count", "disposal"] },
  setup: { label: "Setup", prefixes: ["tenant", "website", "schedule", "doctor", "service", "billing_profile", "settings", "subscription", "department"] },
} as const;
export type AuditGroup = keyof typeof AUDIT_GROUPS;

export type AuditRow = {
  id: number; at: string; who: string; level: string | null; action: string; target: string | null; patient: string | null;
  outcome: "success" | "denied" | "error"; reason: string | null; detail: string | null;
};

const compact = (d: unknown): string | null => {
  if (!d || typeof d !== "object") return null;
  const s = Object.entries(d as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(", ");
  return s ? (s.length > 180 ? `${s.slice(0, 177)}…` : s) : null;
};

export async function listAudit(tenantId: string, f: { from: string; to: string; group: AuditGroup | null; outcome: string | null; member: string | null; before: number | null }) {
  const db = serviceClient();
  const t0 = new Date(`${f.from}T00:00:00+05:45`).toISOString(), t1 = new Date(Date.parse(`${f.to}T00:00:00+05:45`) + 86_400_000).toISOString();
  let q = db.from("audit_log").select("id, created_at, actor_kind, actor_id, session_level, action, target_type, target_id, patient_id, outcome, reason, detail")
    .eq("tenant_id", tenantId).gte("created_at", t0).lt("created_at", t1).order("id", { ascending: false }).limit(101);
  if (f.group) q = q.or(AUDIT_GROUPS[f.group].prefixes.map((p) => `action.like.${p}.*`).join(","));
  if (f.outcome) q = q.eq("outcome", f.outcome);
  if (f.member) q = q.eq("actor_id", f.member);
  if (f.before) q = q.lt("id", f.before);
  const { data, error } = await q;
  if (error) throw new Error(`audit: ${error.message}`);
  const raw = (data ?? []) as { id: number; created_at: string; actor_kind: string; actor_id: string | null; session_level: string | null; action: string; target_type: string | null; target_id: string | null; patient_id: string | null; outcome: AuditRow["outcome"]; reason: string | null; detail: unknown }[];
  const more = raw.length > 100;
  const rows = raw.slice(0, 100);
  const memberIds = [...new Set(rows.filter((r) => r.actor_kind === "member" && r.actor_id).map((r) => r.actor_id!))];
  const patientIds = [...new Set(rows.map((r) => r.patient_id).filter(Boolean) as string[])];
  const [m, p] = await Promise.all([
    memberIds.length ? db.from("tenant_members").select("id, display_name").eq("tenant_id", tenantId).in("id", memberIds) : Promise.resolve({ data: [] }),
    patientIds.length ? db.from("patients").select("id, mrn").eq("tenant_id", tenantId).in("id", patientIds) : Promise.resolve({ data: [] }),
  ]);
  const names = new Map(((m.data ?? []) as { id: string; display_name: string }[]).map((x) => [x.id, x.display_name]));
  const mrns = new Map(((p.data ?? []) as { id: string; mrn: string }[]).map((x) => [x.id, x.mrn]));
  const KIND: Record<string, string> = { platform_admin: "CMediSewa support", patient_account: "A patient", guest_token: "A website visitor", system: "System" };
  return {
    more, next: more ? rows[rows.length - 1]!.id : null,
    rows: rows.map((r): AuditRow => ({
      id: r.id, at: r.created_at, who: r.actor_kind === "member" ? names.get(r.actor_id ?? "") ?? "A former member" : KIND[r.actor_kind] ?? r.actor_kind,
      level: r.session_level, action: r.action, target: r.target_type ? `${r.target_type.replace(/_/g, " ")}${r.target_id && r.target_id.length < 20 ? ` ${r.target_id}` : ""}` : null,
      patient: r.patient_id ? mrns.get(r.patient_id) ?? "a patient" : null, outcome: r.outcome, reason: r.reason, detail: compact(r.detail),
    })),
  };
}

export async function auditMembers(tenantId: string) {
  const { data } = await serviceClient().from("tenant_members").select("id, display_name").eq("tenant_id", tenantId).order("display_name");
  return (data ?? []) as { id: string; display_name: string }[];
}
