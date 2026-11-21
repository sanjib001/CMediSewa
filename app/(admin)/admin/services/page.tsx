import { requireTenant } from "@/lib/auth/context";
import { listCatalogue, type Department, type Service } from "@/lib/tenant/setup-data";
import { saveDepartment, saveService } from "@/app/actions/setup";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Departments & services" };
export const dynamic = "force-dynamic";

const KINDS: [string, string][] = [["consultation", "Consultation (OPD)"], ["procedure", "Procedure"], ["lab", "Lab test"], ["other", "Other"]];
const npr = (n: number) => `Rs. ${Number(n).toLocaleString("en-IN")}`;

function ServiceFields({ sv, departments }: { sv?: Service; departments: Department[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      {sv ? <input type="hidden" name="id" value={sv.id} /> : null}
      <label className="block sm:col-span-2"><span className={label}>Name</span><input name="name" defaultValue={sv?.name} required placeholder="e.g. General OPD" className={field} /></label>
      <label className="block"><span className={label}>Kind</span>
        <select name="kind" defaultValue={sv?.kind ?? "consultation"} className={field}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label className="block"><span className={label}>Price (Rs.)</span><input name="price_npr" type="number" min={0} step="0.01" defaultValue={sv?.price_npr ?? ""} required className={field} /></label>
      <label className="block sm:col-span-2"><span className={label}>Department</span>
        <select name="department_id" defaultValue={sv?.department_id ?? ""} className={field}>
          <option value="">None</option>{departments.filter((d) => d.is_active || d.id === sv?.department_id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select></label>
      <label className="block"><span className={label}>Usual length (minutes)</span><input name="duration_minutes" type="number" min={1} max={480} defaultValue={sv?.duration_minutes ?? ""} className={field} /></label>
      <div className="flex flex-col justify-end gap-1 pb-1">
        <label className="flex items-center gap-2"><input type="checkbox" name="is_public" defaultChecked={sv?.is_public ?? true} />Show on website</label>
        {sv ? <label className="flex items-center gap-2"><input type="checkbox" name="is_active" defaultChecked={sv.is_active} />In use</label> : null}
      </div>
    </div>
  );
}

export default async function Services() {
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_catalogue", allowPendingTenant: true, next: "/admin/services" });
  const { departments, services } = await listCatalogue(ctx.tenantId);
  const deptName = (id: string | null) => departments.find((d) => d.id === id)?.name;
  return (
    <>
      <PageHeader title="Departments & services" subtitle="What the clinic offers and what it costs. The registrar charges these fees; services marked for the website appear on your public page." />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Panel title="Services" aside={<span className="text-sm text-ink-faint">{services.filter((x) => x.is_active).length} in use</span>} flush>
          {services.length === 0 ? <p className="px-5 py-4 text-ink-soft">No services yet. Add a consultation with its fee to start taking patients.</p> : (
            <ul className="divide-y divide-line">
              {services.map((sv) => (
                <li key={sv.id} className="px-5 py-3">
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-4 gap-y-1">
                      <span className={sv.is_active ? "font-medium" : "font-medium text-ink-faint line-through"}>{sv.name}</span>
                      <span className="text-sm text-ink-faint">{KINDS.find(([k]) => k === sv.kind)?.[1]}{deptName(sv.department_id) ? ` in ${deptName(sv.department_id)}` : ""}{sv.is_public ? "" : ", not on website"}</span>
                      <span className="ml-auto tabular-nums">{npr(sv.price_npr)}</span>
                    </summary>
                    <ActionForm action={saveService} submitLabel="Save service" resetOnSuccess={false} className="mt-3"><ServiceFields sv={sv} departments={departments} /></ActionForm>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-line p-5">
            <h3 className="mb-3 font-medium">Add a service</h3>
            <ActionForm action={saveService} submitLabel="Add service"><ServiceFields departments={departments} /></ActionForm>
          </div>
        </Panel>

        <Panel title="Departments" flush>
          {departments.length === 0 ? <p className="px-5 py-4 text-ink-soft">Optional. Group doctors and services, e.g. General medicine, Paediatrics, Dental.</p> : (
            <ul className="divide-y divide-line">
              {departments.map((d) => (
                <li key={d.id} className="px-5 py-3">
                  <details>
                    <summary className={d.is_active ? "cursor-pointer font-medium" : "cursor-pointer font-medium text-ink-faint line-through"}>{d.name}</summary>
                    <ActionForm action={saveDepartment} submitLabel="Save department" resetOnSuccess={false} className="mt-3">
                      <input type="hidden" name="id" value={d.id} />
                      <label className="block"><span className={label}>Name</span><input name="name" defaultValue={d.name} required className={field} /></label>
                      <label className="block"><span className={label}>Description</span><input name="description" defaultValue={d.description ?? ""} className={field} /></label>
                      <label className="block"><span className={label}>Order</span><input name="sort_order" type="number" defaultValue={d.sort_order} className={field} /></label>
                      <label className="flex items-center gap-2"><input type="checkbox" name="is_active" defaultChecked={d.is_active} />In use</label>
                    </ActionForm>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-line p-5">
            <ActionForm action={saveDepartment} submitLabel="Add department">
              <label className="block"><span className={label}>New department</span><input name="name" required placeholder="e.g. Paediatrics" className={field} /></label>
              <label className="block"><span className={label}>Description</span><input name="description" className={field} /></label>
            </ActionForm>
          </div>
        </Panel>
      </div>
    </>
  );
}
