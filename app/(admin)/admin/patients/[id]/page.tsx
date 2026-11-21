import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant, can } from "@/lib/auth/context";
import { getPatient } from "@/lib/patients/data";
import { clearDuplicate, updatePatient } from "@/app/actions/patients";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { CollectDues } from "@/components/pharmacy/bill-corrections";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const metadata = { title: "Patient" };
export const dynamic = "force-dynamic";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const SEX: Record<string, string> = { male: "Male", female: "Female", other: "Other" };
const VISIT: Record<string, string> = { waiting: "Waiting", with_doctor: "With the doctor", awaiting_billing: "Awaiting billing", closed: "Seen", cancelled: "Cancelled" };
const APPT: Record<string, string> = { requested: "Requested", confirmed: "Confirmed", checked_in: "Checked in", in_consultation: "With the doctor", completed: "Completed", cancelled: "Cancelled", no_show: "Didn't come" };
const when = (iso: string, time = true) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", ...(time ? { timeStyle: "short" } : {}) });

// One patient's record (U3b): details (editable by manage_patients), the duplicate check,
// visits, appointments, bills and what is owed. Clinical notes stay in the doctor's chart.
export default async function Patient({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_patients", allowPendingTenant: true, next: `/admin/patients/${id}` });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const p = await getPatient(ctx.tenantId, id);
  if (!p) notFound();
  const edit = can(ctx, "manage_patients"), bills = can(ctx, "view_billing");
  return (
    <>
      <PageHeader title={p.full_name} subtitle={<><Link href="/admin/patients" className="text-pine hover:underline">Patients</Link> / MRN {p.mrn}, {p.age} {SEX[p.sex]}, registered {when(p.created_at, false)}{p.created_via === "online" ? " from the website" : ""}</>} />
      {p.possible_duplicate ? (
        <section aria-label="Possible duplicate" className="mb-6 rounded-panel border border-warn/50 bg-surface p-5">
          <h2 className="font-semibold">This may be the same person as another record</h2>
          {p.candidates.length ? <ul className="mt-2 space-y-1">{p.candidates.map((c) => (
            <li key={c.id}><Link href={`/admin/patients/${c.id}`} className="text-pine hover:underline">{c.full_name}</Link> <span className="text-sm text-ink-soft">MRN {c.mrn}, {c.age}{c.phone ? `, ${c.phone}` : ""} ({c.why})</span></li>))}</ul>
            : <p className="mt-2 text-sm text-ink-soft">The matching record has since changed or been removed.</p>}
          <p className="mt-3 text-sm text-ink-soft">If they are different people (for example family members sharing a phone), mark it so the desk stops warning. Combining two records of the same person comes in a later release; until then, keep using the older record.</p>
          {edit ? <ActionForm action={clearDuplicate} submitLabel="They are different people" tone="secondary" className="mt-3">
            <input type="hidden" name="id" value={p.id} />
            <label className="block"><span className={label}>Note (optional)</span><input name="note" maxLength={200} className={field} placeholder="e.g. Mother and daughter, same phone" /></label>
          </ActionForm> : null}
        </section>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[1fr_1.2fr]">
        <div className="space-y-6">
          <Panel title="Details">
            {edit ? (
              <ActionForm action={updatePatient} submitLabel="Save details" resetOnSuccess={false}>
                <input type="hidden" name="id" value={p.id} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block sm:col-span-2"><span className={label}>Full name</span><input name="full_name" required minLength={2} maxLength={120} defaultValue={p.full_name} className={field} /></label>
                  <label className="block sm:col-span-2"><span className={label}>Name in Nepali</span><input name="full_name_ne" maxLength={120} defaultValue={p.full_name_ne ?? ""} className={field} lang="ne" /></label>
                  <label className="block"><span className={label}>Sex</span><select name="sex" defaultValue={p.sex} className={field}><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></label>
                  <label className="block"><span className={label}>Blood group</span><select name="blood_group" defaultValue={p.blood_group ?? ""} className={field}><option value="">Not known</option>{["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((b) => <option key={b}>{b}</option>)}</select></label>
                  <label className="block"><span className={label}>Date of birth</span><input name="date_of_birth" type="date" defaultValue={p.date_of_birth ?? ""} className={field} /></label>
                  <label className="block"><span className={label}>Or age (years)</span><input name="age_years" type="number" min={0} max={130} defaultValue={p.date_of_birth ? "" : p.age_years ?? ""} className={field} /></label>
                  <label className="block"><span className={label}>Phone</span><input name="phone" type="tel" defaultValue={p.phone ?? ""} className={field} /></label>
                  <label className="block"><span className={label}>Other phone</span><input name="alt_phone" type="tel" defaultValue={p.alt_phone ?? ""} className={field} /></label>
                  <label className="block sm:col-span-2"><span className={label}>Email</span><input name="email" type="email" defaultValue={p.email ?? ""} className={field} /></label>
                  <label className="block sm:col-span-2"><span className={label}>Address</span><input name="address" maxLength={200} defaultValue={p.address ?? ""} className={field} /></label>
                  <label className="block"><span className={label}>Guardian</span><input name="guardian_name" maxLength={120} defaultValue={p.guardian_name ?? ""} className={field} /></label>
                  <label className="block"><span className={label}>Relation</span><input name="guardian_relation" maxLength={40} defaultValue={p.guardian_relation ?? ""} className={field} placeholder="e.g. mother" /></label>
                </div>
              </ActionForm>
            ) : (
              <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-[0.95rem]">
                {[["Phone", p.phone], ["Other phone", p.alt_phone], ["Email", p.email], ["Address", p.address], ["Guardian", p.guardian_name ? `${p.guardian_name}${p.guardian_relation ? ` (${p.guardian_relation})` : ""}` : null], ["Blood group", p.blood_group]]
                  .map(([k, v]) => <div key={k} className="contents"><dt className="text-ink-soft">{k}</dt><dd>{v ?? "—"}</dd></div>)}
              </dl>
            )}
          </Panel>
          {p.owed > 0 ? (
            <Panel title={`Owes ${npr(p.owed)}`}>
              <p className="mb-3 text-sm text-ink-soft">Payments clear the oldest bill first.</p>
              {can(ctx, "manage_billing") || can(ctx, "pharmacy_sell") ? <CollectDues key={p.owed} patientId={p.id} owed={p.owed} /> : null}
            </Panel>
          ) : null}
        </div>

        <div className="space-y-6">
          <Panel title="Visits" flush>
            {p.visits.length === 0 ? <p className="px-5 py-4 text-ink-soft">No visits yet.</p> : (
              <ul className="divide-y divide-line">{p.visits.map((v) => (
                <li key={v.id} className="flex justify-between gap-3 px-5 py-2.5"><span>{when(`${v.date}T12:00:00+05:45`, false)}, Dr. {v.doctor}, token {v.token}</span><span className="text-sm text-ink-soft">{VISIT[v.status] ?? v.status}</span></li>))}</ul>
            )}
          </Panel>
          <Panel title="Appointments" flush>
            {p.appointments.length === 0 ? <p className="px-5 py-4 text-ink-soft">No appointments.</p> : (
              <ul className="divide-y divide-line">{p.appointments.map((a) => (
                <li key={a.id} className="flex justify-between gap-3 px-5 py-2.5"><span>{a.at ? when(a.at) : ""}, Dr. {a.doctor}{a.source === "online" ? " (website)" : ""}</span>
                  <span className={cn("text-sm", a.status === "no_show" ? "text-warn" : "text-ink-soft")}>{APPT[a.status] ?? a.status}</span></li>))}</ul>
            )}
          </Panel>
          <Panel title="Bills" flush>
            {p.bills.length === 0 ? <p className="px-5 py-4 text-ink-soft">No bills.</p> : (
              <ul className="divide-y divide-line">{p.bills.map((b) => (
                <li key={b.id} className={cn("flex justify-between gap-3 px-5 py-2.5", b.status === "void" && "text-ink-faint line-through")}>
                  <span>{bills ? <Link href={`/admin/billing/${b.id}`} className="text-pine hover:underline">{b.invoice_no}</Link> : b.invoice_no} <span className="text-sm text-ink-soft">{when(b.at, false)}, {b.source === "visit" ? "OPD" : "pharmacy"}</span></span>
                  <span className="tabular-nums">{npr(b.total)}{b.owed > 0 ? <span className="block text-right text-xs text-warn">owes {npr(b.owed)}</span> : null}</span>
                </li>))}</ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
