import "server-only";
import { serviceClient } from "@/lib/supabase/service";

// Patient advances (M-52): what the clinic holds for a patient and how it moved. Deposits
// and refunds are patient_advances rows; use is the advance leg of a payment (a void gives
// its share back as a negative use).

export type AdvanceMove = { id: string; at: string; kind: "deposit" | "refund" | "used" | "returned"; no: string; amount: number; note: string | null; printable: boolean };
export type AdvanceSummary = { balance: number; owed: number; moves: AdvanceMove[] };

const num = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;

export async function advanceSummary(tenantId: string, patientId: string, limit = 12): Promise<AdvanceSummary> {
  const db = serviceClient();
  const [bal, open, adv, used] = await Promise.all([
    db.rpc("patient_advance_balance", { p_tenant: tenantId, p_patient: patientId }),
    db.rpc("patient_open_bills", { p_tenant: tenantId, p_patient: patientId }),
    db.from("patient_advances").select("id, received_at, kind, receipt_no, amount, note").eq("tenant_id", tenantId).eq("patient_id", patientId).order("received_at", { ascending: false }).limit(limit),
    db.from("payments").select("id, received_at, receipt_no, advance_amount").eq("tenant_id", tenantId).eq("patient_id", patientId).neq("advance_amount", 0).order("received_at", { ascending: false }).limit(limit),
  ]);
  for (const r of [bal, open, adv, used]) if (r.error) throw new Error(`advances: ${r.error.message}`);
  const moves: AdvanceMove[] = [
    ...((adv.data ?? []) as { id: string; received_at: string; kind: "deposit" | "refund"; receipt_no: string; amount: number; note: string | null }[])
      .map((a) => ({ id: a.id, at: a.received_at, kind: a.kind, no: a.receipt_no, amount: num(a.amount), note: a.note, printable: true })),
    ...((used.data ?? []) as { id: string; received_at: string; receipt_no: string; advance_amount: number }[])
      .map((p) => ({ id: p.id, at: p.received_at, kind: (num(p.advance_amount) > 0 ? "used" : "returned") as AdvanceMove["kind"], no: p.receipt_no, amount: -num(p.advance_amount), note: null, printable: false })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  const owed = ((open.data ?? []) as { outstanding: number }[]).reduce((s, o) => s + Number(o.outstanding), 0);
  return { balance: num(bal.data), owed: num(owed), moves };
}

/** One deposit or refund, for its printed receipt. */
export async function advanceReceipt(tenantId: string, id: string) {
  const db = serviceClient();
  const { data: a } = await db.from("patient_advances").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (!a) return null;
  const [{ data: p }, { data: bp }, { data: m }, bal] = await Promise.all([
    db.from("patients").select("full_name, mrn").eq("id", a.patient_id).single(),
    db.from("billing_profiles").select("legal_name, name, address, phone, pan_vat_no, receipt_footer").eq("id", a.billing_profile_id).maybeSingle(),
    db.from("tenant_members").select("display_name").eq("id", a.received_by).maybeSingle(),
    db.rpc("patient_advance_balance", { p_tenant: tenantId, p_patient: a.patient_id }),
  ]);
  return {
    no: a.receipt_no as string, kind: a.kind as "deposit" | "refund", at: a.received_at as string, amount: num(a.amount), cash: num(a.cash_amount), online: num(a.online_amount),
    channel: a.online_channel as string | null, reference: a.reference as string | null, note: a.note as string | null,
    patient: p as { full_name: string; mrn: string }, clinic: bp as { legal_name: string; name: string; address: string | null; phone: string | null; pan_vat_no: string | null; receipt_footer: string | null } | null,
    by: (m?.display_name as string | undefined) ?? "", heldNow: num(bal.data),
  };
}
