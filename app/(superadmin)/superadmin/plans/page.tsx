import { requireSuperAdmin } from "@/lib/auth/guards";
import { listPlans, npr, type Plan } from "@/lib/platform/admin-data";
import { savePlan } from "@/app/actions/platform";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";
import Link from "next/link";
import { serviceClient } from "@/lib/supabase/service";

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
  const db = serviceClient();
  const [inv, pay, ten] = await Promise.all([
    db.from("platform_invoices").select("id, tenant_id, invoice_no, description, amount_npr, due_on, status, issued_at").order("issued_at", { ascending: false }).limit(200),
    db.from("platform_payments").select("invoice_id, amount_npr"),
    db.from("tenants").select("id, name"),
  ]);
  const paid = new Map<string, number>();
  for (const p of (pay.data ?? []) as { invoice_id: string; amount_npr: number }[]) paid.set(p.invoice_id, (paid.get(p.invoice_id) ?? 0) + Number(p.amount_npr));
  const tname = new Map(((ten.data ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]));
  const invoices = ((inv.data ?? []) as { id: string; tenant_id: string; invoice_no: string; description: string; amount_npr: number; due_on: string | null; status: string }[])
    .map((i) => ({ ...i, clinic: tname.get(i.tenant_id) ?? "", amount: Number(i.amount_npr), owed: i.status === "void" ? 0 : Math.max(0, Number(i.amount_npr) - (paid.get(i.id) ?? 0)) }));
  const owedTotal = invoices.reduce((t, i) => t + i.owed, 0);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(new Date());
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
        <Panel title="Invoices to clinics" aside={<span className="text-sm text-ink-faint">{owedTotal ? `${npr(owedTotal)} outstanding` : "Nothing outstanding"}</span>} flush>
          {invoices.length === 0 ? <p className="px-5 py-4 text-ink-soft">No invoices yet. Issue them from a clinic&apos;s page.</p> : (
            <table className="w-full text-left text-[0.95rem]">
              <thead className="text-sm text-ink-faint"><tr><th className="px-5 py-2 font-medium">Invoice</th><th className="py-2 font-medium">Clinic</th><th className="py-2 font-medium">Due</th><th className="py-2 text-right font-medium">Amount</th><th className="px-5 py-2 text-right font-medium">Outstanding</th></tr></thead>
              <tbody className="divide-y divide-line">{invoices.map((i) => (
                <tr key={i.id} className={i.status === "void" ? "text-ink-faint line-through" : ""}>
                  <td className="px-5 py-2.5">{i.invoice_no}<span className="block text-xs text-ink-faint">{i.description}</span></td>
                  <td className="py-2.5"><Link href={`/superadmin/tenants/${i.tenant_id}`} className="text-pine hover:underline">{i.clinic}</Link></td>
                  <td className="py-2.5 text-sm">{i.due_on ?? "—"}</td>
                  <td className="py-2.5 text-right tabular-nums">{npr(i.amount)}</td>
                  <td className={`px-5 py-2.5 text-right tabular-nums ${i.owed > 0 && i.due_on && i.due_on < today ? "text-alert" : ""}`}>{i.status === "void" ? "void" : i.owed > 0 ? npr(i.owed) : "paid"}</td>
                </tr>))}</tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}
