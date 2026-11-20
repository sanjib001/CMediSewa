import { requireSuperAdmin } from "@/lib/auth/guards";
import { listPlans, npr, type Plan } from "@/lib/platform/admin-data";
import { savePlan } from "@/app/actions/platform";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Plans & billing" };
export const dynamic = "force-dynamic";

const FEATURES = [["lab", "Laboratory (Phase 3)"], ["sms", "SMS (Phase 2)"], ["multi_store", "More than 2 stores"]] as const;

function PlanFields({ p }: { p?: Plan }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {p ? <input type="hidden" name="id" value={p.id} /> : null}
      <label className="block"><span className={label}>Name</span><input name="name" defaultValue={p?.name} required className={field} /></label>
      <label className="block"><span className={label}>Code</span><input name="code" defaultValue={p?.code} required pattern="[a-z0-9-]{2,40}" className={field} /></label>
      <label className="block"><span className={label}>Price (Rs.)</span><input name="price_npr" type="number" min={0} step="0.01" defaultValue={p?.price_npr ?? 0} className={field} /></label>
      <label className="block"><span className={label}>Billing cycle (days)</span><input name="billing_cycle_days" type="number" min={1} max={1100} defaultValue={p?.billing_cycle_days ?? 365} className={field} /></label>
      <label className="block"><span className={label}>Max doctors</span><input name="max_doctors" type="number" min={1} defaultValue={p?.max_doctors ?? ""} className={field} /></label>
      <label className="block"><span className={label}>Max staff</span><input name="max_members" type="number" min={1} defaultValue={p?.max_members ?? ""} className={field} /></label>
      <label className="block sm:col-span-3"><span className={label}>Description</span><input name="description" defaultValue={p?.description ?? ""} className={field} /></label>
      <fieldset className="sm:col-span-3"><legend className={label}>Includes</legend>
        <div className="flex flex-wrap gap-4">{FEATURES.map(([k, l]) => (
          <label key={k} className="flex items-center gap-2"><input type="checkbox" name="features" value={k} defaultChecked={p?.features.includes(k)} />{l}</label>))}</div>
      </fieldset>
      <label className="flex items-center gap-2"><input type="checkbox" name="is_public" defaultChecked={p?.is_public} />Show on the pricing page</label>
      {p ? <label className="flex items-center gap-2"><input type="checkbox" name="is_active" defaultChecked={p.is_active} />Active</label> : null}
    </div>
  );
}

export default async function Plans() {
  await requireSuperAdmin();
  const plans = await listPlans();
  return (
    <>
      <PageHeader title="Plans & billing" subtitle="Plans clinics subscribe to. Public plans appear on the marketing pricing page." />
      <div className="space-y-6">
        {plans.map((p) => (
          <Panel key={p.id} title={p.name} aside={<span className="text-sm text-ink-faint">{npr(p.price_npr)} / {p.billing_cycle_days} days{p.is_public ? " · public" : ""}{p.is_active ? "" : " · inactive"}</span>}>
            <details>
              <summary className="cursor-pointer text-sm text-pine">Edit</summary>
              <ActionForm action={savePlan} submitLabel="Save plan" resetOnSuccess={false} className="mt-3"><PlanFields p={p} /></ActionForm>
            </details>
          </Panel>
        ))}
        <Panel title="New plan"><ActionForm action={savePlan} submitLabel="Create plan"><PlanFields /></ActionForm></Panel>
      </div>
    </>
  );
}
