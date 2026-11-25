import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant, can } from "@/lib/auth/context";
import { getPatient, mergedRecord, patientMerges } from "@/lib/patients/data";
import { clearDuplicate, mergePatients, undoPatientMerge, updatePatient } from "@/app/actions/patients";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { CollectDues } from "@/components/pharmacy/bill-corrections";
import { AdvancePanel } from "@/components/billing/advance-panel";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { drName } from "@/lib/doctor-name";

export const metadata = { title: "Patient" };
export const dynamic = "force-dynamic";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const SEX: Record<string, string> = { male: "Male", female: "Female", other: "Other" };
const VISIT: Record<string, string> = { waiting: "Waiting", with_doctor: "With the doctor", awaiting_billing: "Awaiting billing", closed: "Seen", cancelled: "Cancelled" };
const APPT: Record<string, string> = { requested: "Requested", confirmed: "Confirmed", checked_in: "Checked in", in_consultation: "With the doctor", completed: "Completed", cancelled: "Cancelled", no_show: "Didn't come" };
const when = (iso: string, time = true) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", ...(time ? { timeStyle: "short" } : {}) });

// One patient's record (U3b): details (editable by manage_patients), the duplicate check,
// visits, appointments, bills and what is owed. Clinical notes stay in the doctor's chart.
// Two records of one person can be combined (M-37) and the combination undone.
export default async function Patient({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ combine?: string }> }) {
  const { id } = await params;
  const { combine } = await searchParams;
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_patients", allowPendingTenant: true, next: `/admin/patients/${id}` });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const p = await getPatient(ctx.tenantId, id);
  if (!p) {
    const m = await mergedRecord(ctx.tenantId, id);
    if (!m) notFound();
    return <MergedAway id={id} m={m} edit={can(ctx, "manage_patients")} />;
  }
  const edit = can(ctx, "manage_patients"), bills = can(ctx, "view_billing");
  const merges = await patientMerges(ctx.tenantId, id);
  const otherMrn = /^\d{1,6}$/.test(combine ?? "") ? combine!.padStart(6, "0") : "";
  return (
    <>
      <PageHeader title={p.full_name} subtitle={<><Link href="/admin/patients" className="text-pine hover:underline">Patients</Link> / MRN {p.mrn}, {p.age} {SEX[p.sex]}, registered {when(p.created_at, false)}{p.created_via === "online" ? " from the website" : ""}</>} />
      {p.possible_duplicate ? (
        <section aria-label="Possible duplicate" className="mb-6 rounded-panel border border-warn/50 bg-surface p-5">
          <h2 className="font-semibold">This may be the same person as another record</h2>
          {p.candidates.length ? <ul className="mt-2 space-y-1">{p.candidates.map((c) => (
            <li key={c.id}><Link href={`/admin/patients/${c.id}`} className="text-pine hover:underline">{c.full_name}</Link> <span className="text-sm text-ink-soft">MRN {c.mrn}, {c.age}{c.phone ? `, ${c.phone}` : ""} ({c.why})</span>
              {edit ? <> · <Link href={`/admin/patients/${p.id}?combine=${c.mrn}#combine`} className="text-sm text-pine hover:underline">Same person: combine</Link></> : null}</li>))}</ul>
            : <p className="mt-2 text-sm text-ink-soft">The matching record has since changed or been removed.</p>}
          <p className="mt-3 text-sm text-ink-soft">If it is the same person, combine the two records. If they are different people (for example family members sharing a phone), mark it so the desk stops warning.</p>
          {edit ? <ActionForm action={clearDuplicate} submitLabel="They are different people" tone="secondary" className="mt-3">
            <input type="hidden" name="id" value={p.id} />
            <label className="block"><span className={label}>Note (optional)</span><input name="note" maxLength={200} className={field} placeholder="e.g. Mother and daughter, same phone" /></label>
          </ActionForm> : null}
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_1.2fr]">
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
          {edit ? (
            <section id="combine" aria-label="Combine with another record" className="scroll-mt-6">
              <Panel title="Combine with another record">
                <p className="mb-3 text-sm text-ink-soft">For the same person registered twice. Visits, appointments, bills, payments, advances, allergies, vitals, consultations and prescriptions all move to the record you keep; the other record&apos;s MRN still finds them. It can be undone.</p>
                <ActionForm key={otherMrn} action={mergePatients} submitLabel="Combine records" tone="danger" confirm="Combine these two records into one? Everything moves to the record you keep.">
                  <input type="hidden" name="id" value={p.id} />
                  <label className="block"><span className={label}>MRN of the other record</span><input name="other_mrn" required inputMode="numeric" pattern="[0-9]{1,6}" maxLength={6} defaultValue={otherMrn} className={field} placeholder="e.g. 000123" /></label>
                  <fieldset><legend className={label}>Keep</legend>
                    <div className="flex flex-wrap gap-x-5 gap-y-1">
                      <label className="flex items-center gap-2"><input type="radio" name="keep" value="this" defaultChecked={!otherMrn || otherMrn > p.mrn} /> This record (MRN {p.mrn})</label>
                      <label className="flex items-center gap-2"><input type="radio" name="keep" value="other" defaultChecked={!!otherMrn && otherMrn < p.mrn} /> The other record</label>
                    </div>
                    <span className="mt-1 block text-xs text-ink-soft">Usually the older record (lower MRN). The kept record&apos;s details stay; copy anything missing from the other first.</span>
                  </fieldset>
                  <label className="block"><span className={label}>Reason (optional)</span><input name="reason" maxLength={200} className={field} placeholder="e.g. Registered again at the desk" /></label>
                  <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirm" value="yes" required className="mt-1" /> I have checked these are the same person.</label>
                </ActionForm>
              </Panel>
            </section>
          ) : null}
          {merges.length ? (
            <Panel title="Combined records" flush>
              <ul className="divide-y divide-line">{merges.map((m) => (
                <li key={m.id} className="px-5 py-3">
                  <p><Link href={`/admin/patients/${m.other_id}`} className="text-pine hover:underline">MRN {m.other_mrn}</Link> {m.other_name} <span className="text-sm text-ink-soft">combined {when(m.at)}{m.by ? ` by ${m.by}` : ""}{m.reason ? ` (${m.reason})` : ""}</span></p>
                  {edit ? <ActionForm action={undoPatientMerge} submitLabel="Undo" tone="secondary" className="mt-2" confirm={`Separate MRN ${m.other_mrn} again? Its own records move back to it.`}>
                    <input type="hidden" name="id" value={p.id} /><input type="hidden" name="merge" value={m.id} />
                  </ActionForm> : null}
                </li>))}</ul>
            </Panel>
          ) : null}
          {p.owed > 0 ? (
            <Panel title={`Owes ${npr(p.owed)}`}>
              <p className="mb-3 text-sm text-ink-soft">Payments clear the oldest bill first.</p>
              {can(ctx, "manage_billing") || can(ctx, "pharmacy_sell") ? <CollectDues key={p.owed} patientId={p.id} owed={p.owed} /> : null}
            </Panel>
          ) : null}
          {can(ctx, "manage_billing") || can(ctx, "pharmacy_sell") ? (
            <Panel title="Advance">
              <AdvancePanel patientId={p.id} canTake canRefund={can(ctx, "manage_billing")} />
            </Panel>
          ) : null}
        </div>

        <div className="space-y-6">
          <Panel title="Visits" flush>
            {p.visits.length === 0 ? <p className="px-5 py-4 text-ink-soft">No visits yet.</p> : (
              <ul className="divide-y divide-line">{p.visits.map((v) => (
                <li key={v.id} className="flex justify-between gap-3 px-5 py-2.5"><span>{when(`${v.date}T12:00:00+05:45`, false)}, {drName(v.doctor)}, token {v.token}</span><span className="text-sm text-ink-soft">{VISIT[v.status] ?? v.status}</span></li>))}</ul>
            )}
          </Panel>
          <Panel title="Appointments" flush>
            {p.appointments.length === 0 ? <p className="px-5 py-4 text-ink-soft">No appointments.</p> : (
              <ul className="divide-y divide-line">{p.appointments.map((a) => (
                <li key={a.id} className="flex justify-between gap-3 px-5 py-2.5"><span>{a.at ? when(a.at) : ""}, {drName(a.doctor)}{a.source === "online" ? " (website)" : ""}</span>
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

function MergedAway({ id, m, edit }: { id: string; m: NonNullable<Awaited<ReturnType<typeof mergedRecord>>>; edit: boolean }) {
  return (
    <>
      <PageHeader title={m.full_name} subtitle={<><Link href="/admin/patients" className="text-pine hover:underline">Patients</Link> / MRN {m.mrn}</>} />
      <section aria-label="Combined record" className="rounded-panel border border-line bg-surface p-5">
        <h2 className="font-semibold">This record was combined into another</h2>
        <p className="mt-2">
          {m.kept && !m.kept.deleted_at ? <>Everything is now on <Link href={`/admin/patients/${m.kept.id}`} className="text-pine hover:underline">{m.kept.full_name} (MRN {m.kept.mrn})</Link>.</> : <>Everything moved on to the record it was combined into, which has since been combined again.</>}
          <span className="block text-sm text-ink-soft">Combined {when(m.at)}.</span>
        </p>
        {edit && m.mergeId && m.kept && !m.kept.deleted_at ? (
          <ActionForm action={undoPatientMerge} submitLabel="Undo: make them separate again" tone="secondary" className="mt-3" confirm={`Separate MRN ${m.mrn} again? Its own records move back to it.`}>
            <input type="hidden" name="id" value={id} /><input type="hidden" name="merge" value={m.mergeId} />
          </ActionForm>
        ) : null}
      </section>
    </>
  );
}
