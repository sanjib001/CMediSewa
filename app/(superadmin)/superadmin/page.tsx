import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { getPlatformOverview, describeEvent, formatKathmandu } from "@/lib/platform/overview";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { adToBs, formatBs, localDate } from "@/lib/clinic-time";
import { cn } from "@/lib/cn";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  active: "bg-ok-tint text-ok",
  pending: "bg-sunken text-ink-soft",
  suspended: "bg-alert-tint text-alert",
  closed: "bg-sunken text-ink-faint",
};
const TYPE_LABEL: Record<string, string> = { clinic_pharmacy: "Clinic + pharmacy", clinic: "Clinic", pharmacy: "Pharmacy" };

export default async function PlatformOverview() {
  const { admin } = await requireSuperAdmin();
  const o = await getPlatformOverview();
  const today = localDate(new Date());
  const total = o.tenants.length;

  return (
    <>
      <PageHeader
        title={`Namaste, ${admin.displayName.split(" ")[0]}`}
        subtitle={`${formatBs(adToBs(today))} · Counts and subscription status only. Patient, stock and money detail stay inside each clinic.`}
      />

      {o.pendingApplications > 0 ? (
        <Link href="/superadmin/applications" className="mb-5 flex items-center justify-between rounded-panel border border-marigold bg-marigold-tint px-5 py-3 text-marigold-ink hover:brightness-95">
          <span><span className="font-semibold">{o.pendingApplications}</span> {o.pendingApplications === 1 ? "registration is" : "registrations are"} waiting for your review</span>
          <span className="font-medium">Review</span>
        </Link>
      ) : null}

      <section aria-label="Clinics by status" className="mb-6 flex flex-wrap items-baseline gap-x-8 gap-y-2 border-y border-line py-4">
        <Figure value={total} label={total === 1 ? "clinic" : "clinics"} />
        <Figure value={o.byStatus.active} label="live" tone="text-ok" />
        <Figure value={o.byStatus.pending} label="setting up" />
        <Figure value={o.byStatus.suspended} label="suspended" tone={o.byStatus.suspended ? "text-alert" : undefined} />
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <Panel title="Clinics" flush>
          {total === 0 ? (
            <div className="px-5 py-8">
              <p className="font-medium">No clinics yet</p>
              <p className="mt-1 max-w-md text-ink-soft">
                Clinics join through the registration form on the marketing site, and you approve them here.
                New registrations appear under Applications.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-[0.95rem]">
                <thead className="border-b border-line text-sm text-ink-faint">
                  <tr><th className="px-5 py-2.5 font-medium">Clinic</th><th className="py-2.5 font-medium">Status</th><th className="py-2.5 font-medium">Type</th><th className="px-5 py-2.5 text-right font-medium">Joined</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {o.tenants.map((t) => (
                    <tr key={t.id}>
                      <td className="px-5 py-3"><Link href={`/superadmin/tenants/${t.id}`} className="font-medium text-pine hover:underline">{t.name}</Link><div className="text-sm text-ink-faint">/{t.slug}</div></td>
                      <td className="py-3"><span className={cn("rounded-full px-2.5 py-0.5 text-sm font-medium capitalize", STATUS_STYLE[t.status])}>{t.status}</span></td>
                      <td className="py-3 text-ink-soft">{TYPE_LABEL[t.business_type] ?? t.business_type}</td>
                      <td className="px-5 py-3 text-right text-ink-soft">{formatKathmandu(t.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="space-y-6">
          <Panel title="Platform activity" flush>
            {o.events.length === 0 ? (
              <p className="px-5 py-4 text-ink-soft">No platform events yet.</p>
            ) : (
              <ol className="divide-y divide-line">
                {o.events.map((e) => (
                  <li key={e.id} className="flex gap-4 px-5 py-2.5 text-[0.95rem]">
                    <span className="w-28 shrink-0 text-sm text-ink-faint">{formatKathmandu(e.created_at)}</span>
                    <span className={e.outcome === "success" ? "" : "text-alert"}>{describeEvent(e)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel title="Platform">
            <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-[0.95rem]">
              <dt className="text-ink-soft">Active platform admins</dt><dd className="text-right">{o.activeAdmins}</dd>
              <dt className="text-ink-soft">Fiscal calendar seeded to</dt>
              <dd className="text-right">{o.fiscalCoverage ? `FY ${o.fiscalCoverage.code}` : "missing"}</dd>
              <dt className="text-ink-soft">Database</dt><dd className="text-right">Development</dd>
            </dl>
          </Panel>
        </div>
      </div>
    </>
  );
}

function Figure({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <p className="flex items-baseline gap-2">
      <span className={cn("text-3xl font-semibold", tone)}>{value}</span>
      <span className="text-ink-soft">{label}</span>
    </p>
  );
}
