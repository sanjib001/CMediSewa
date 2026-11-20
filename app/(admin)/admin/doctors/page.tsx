import Link from "next/link";
import { requireTenant } from "@/lib/auth/context";
import { listCatalogue, listDoctors, listStaff } from "@/lib/tenant/setup-data";
import { saveDoctor } from "@/app/actions/setup";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { ButtonLink, PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Doctors & schedules" };
export const dynamic = "force-dynamic";

export default async function Doctors() {
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_schedules", allowPendingTenant: true, next: "/admin/doctors" });
  const [doctors, { staff }, { departments }] = await Promise.all([listDoctors(ctx.tenantId), listStaff(ctx.tenantId), listCatalogue(ctx.tenantId)]);
  const candidates = staff.filter((m) => m.is_active && !doctors.some((d) => d.member_id === m.id));
  return (
    <>
      <PageHeader title="Doctors & schedules" subtitle="Who sees patients, when, and for how much. A doctor appears on your website once their NMC registration is verified."
        actions={<ButtonLink href="/admin/staff" tone="secondary">Invite a doctor</ButtonLink>} />
      <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Panel title="Doctors" flush>
          {doctors.length === 0 ? (
            <p className="px-5 py-4 text-ink-soft">No doctors yet. Invite them in Staff &amp; roles, then add their OPD details here.</p>
          ) : (
            <ul className="divide-y divide-line">
              {doctors.map((d) => (
                <li key={d.member_id}>
                  <Link href={`/admin/doctors/${d.member_id}`} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3.5 hover:bg-sunken">
                    <div className="min-w-0 flex-1">
                      <div className={d.is_active ? "font-medium" : "font-medium text-ink-faint"}>{d.name}{d.is_active ? "" : " (inactive)"}</div>
                      <div className="text-sm text-ink-faint">{[d.specialty, d.room].filter(Boolean).join(", ") || "No specialty yet"}</div>
                    </div>
                    <span className="text-sm">
                      {!d.credential ? <span className="text-warn">No NMC number</span>
                        : d.credential.verified_at ? <span className="text-ok">NMC verified</span>
                        : <span className="text-warn">NMC not verified</span>}
                    </span>
                    <span className="text-sm text-ink-soft">{d.windows === 0 ? <span className="text-warn">No OPD schedule</span> : `${d.windows} weekly OPD ${d.windows === 1 ? "window" : "windows"}`}</span>
                    {d.consultation_fee !== null ? <span className="tabular-nums text-sm">Rs. {Number(d.consultation_fee).toLocaleString("en-IN")}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Add a doctor">
          {candidates.length === 0 ? (
            <p className="text-ink-soft">Everyone on the staff list is already set up. <Link className="text-pine underline" href="/admin/staff">Invite a doctor</Link> first.</p>
          ) : (
            <ActionForm action={saveDoctor} submitLabel="Add doctor">
              <label className="block"><span className={label}>Staff member</span>
                <select name="member_id" required className={field}>{candidates.map((m) => <option key={m.id} value={m.id}>{m.display_name}{m.title ? `, ${m.title}` : ""}</option>)}</select></label>
              <label className="block"><span className={label}>Specialty</span><input name="specialty" placeholder="e.g. General medicine" className={field} /></label>
              <label className="block"><span className={label}>Consultation fee (Rs.)</span><input name="consultation_fee" type="number" min={0} step="0.01" className={field} /></label>
              <label className="block"><span className={label}>Room</span><input name="room" placeholder="e.g. Room 2" className={field} /></label>
              {departments.length ? (
                <fieldset><legend className={label}>Departments</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">{departments.filter((x) => x.is_active).map((x) => (
                    <label key={x.id} className="flex items-center gap-2"><input type="checkbox" name="department_ids" value={x.id} />{x.name}</label>))}</div>
                </fieldset>
              ) : null}
              <label className="flex items-center gap-2"><input type="checkbox" name="is_public" defaultChecked />Show on the clinic website</label>
            </ActionForm>
          )}
        </Panel>
      </div>
    </>
  );
}
