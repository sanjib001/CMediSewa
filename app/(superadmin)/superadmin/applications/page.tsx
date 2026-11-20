import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { listApplications, listPlans, slugify } from "@/lib/platform/admin-data";
import { approveApplication, rejectApplication } from "@/app/actions/platform";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { formatKathmandu } from "@/lib/platform/overview";
import { localDate, isoDate } from "@/lib/clinic-time";
import { cn } from "@/lib/cn";

export const metadata = { title: "Applications" };
export const dynamic = "force-dynamic";

const TABS = [["submitted", "Waiting"], ["approved", "Approved"], ["rejected", "Rejected"]] as const;

export default async function Applications({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireSuperAdmin();
  const { status: raw } = await searchParams;
  const status = (TABS.find(([k]) => k === raw)?.[0] ?? "submitted") as "submitted" | "approved" | "rejected";
  const [apps, plans] = await Promise.all([listApplications(status), listPlans()]);
  const activePlans = plans.filter((p) => p.is_active);
  const today = isoDate(localDate(new Date()));

  return (
    <>
      <PageHeader title="Applications" subtitle="Clinics that registered on the website. Review each one, call them if needed, then approve or reject." />
      <nav className="mb-5 flex gap-1 border-b border-line" aria-label="Application status">
        {TABS.map(([k, l]) => (
          <Link key={k} href={`/superadmin/applications?status=${k}`} aria-current={k === status ? "page" : undefined}
            className={cn("border-b-2 px-3 py-2", k === status ? "border-pine font-medium text-pine-deep" : "border-transparent text-ink-soft hover:text-ink")}>{l}</Link>
        ))}
      </nav>

      {activePlans.length === 0 && status === "submitted" ? (
        <p className="mb-5 rounded-control bg-warn-tint px-4 py-2 text-warn">
          Create a plan first: approving an application needs one. <Link className="underline" href="/superadmin/plans">Plans & billing</Link>
        </p>
      ) : null}

      {apps.length === 0 ? (
        <Panel><p className="text-ink-soft">{status === "submitted" ? "No applications waiting. New registrations from the website appear here." : "Nothing here yet."}</p></Panel>
      ) : (
        <div className="space-y-5">
          {apps.map((a) => (
            <Panel key={a.id} title={a.business_name} aside={<span className="text-sm text-ink-faint">{formatKathmandu(a.created_at)}</span>}>
              <dl className="grid gap-x-8 gap-y-1.5 text-[0.95rem] sm:grid-cols-2">
                <div><dt className="inline text-ink-faint">Owner </dt><dd className="inline">{a.owner_name}</dd></div>
                <div><dt className="inline text-ink-faint">Phone </dt><dd className="inline">{a.phone}</dd></div>
                <div><dt className="inline text-ink-faint">Email </dt><dd className="inline">{a.email}</dd></div>
                <div><dt className="inline text-ink-faint">Place </dt><dd className="inline">{[a.municipality, a.district].filter(Boolean).join(", ") || "not given"}</dd></div>
                <div><dt className="inline text-ink-faint">PAN </dt><dd className="inline">{a.pan_number ?? "not given"}</dd></div>
                {a.plan_interest ? <div><dt className="inline text-ink-faint">Interested in </dt><dd className="inline">{plans.find((p) => p.id === a.plan_interest)?.name ?? "a plan"}</dd></div> : null}
              </dl>
              {a.message ? <p className="mt-3 rounded-control bg-sunken px-3 py-2 text-ink-soft">{a.message}</p> : null}
              {a.status === "rejected" ? <p className="mt-3 text-alert">Rejected: {a.reject_reason}</p> : null}
              {a.status === "approved" && a.tenant_id ? <p className="mt-3"><Link className="text-pine hover:underline" href={`/superadmin/tenants/${a.tenant_id}`}>Open the clinic</Link></p> : null}

              {a.status === "submitted" ? (
                <div className="mt-5 grid gap-6 border-t border-line pt-5 lg:grid-cols-[1.4fr_1fr]">
                  <ActionForm action={approveApplication} submitLabel="Approve and create clinic" resetOnSuccess={false}>
                    <input type="hidden" name="application_id" value={a.id} />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block"><span className={label}>Clinic link</span>
                        <input name="slug" defaultValue={slugify(a.business_name)} required className={field} />
                        <span className="mt-1 block text-xs text-ink-faint">/c/… and /login/… use this</span></label>
                      <label className="block"><span className={label}>Plan</span>
                        <select name="plan_id" required className={field} defaultValue={a.plan_interest ?? activePlans[0]?.id}>
                          {activePlans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select></label>
                      <label className="block"><span className={label}>Starts on</span>
                        <input name="starts_on" type="date" defaultValue={today} required className={field} /></label>
                      <label className="block"><span className={label}>Length (days)</span>
                        <input name="period_days" type="number" min={1} max={1100} defaultValue={30} required className={field} /></label>
                      <label className="block sm:col-span-2"><span className={label}>First period is</span>
                        <select name="source" className={field} defaultValue="trial">
                          <option value="trial">Trial</option><option value="paid">Paid</option><option value="complimentary">Complimentary</option>
                        </select></label>
                    </div>
                  </ActionForm>
                  <ActionForm action={rejectApplication} submitLabel="Reject" tone="secondary">
                    <input type="hidden" name="application_id" value={a.id} />
                    <label className="block"><span className={label}>Reason (kept in the record)</span>
                      <textarea name="reason" rows={3} required className={field} /></label>
                  </ActionForm>
                </div>
              ) : null}
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
