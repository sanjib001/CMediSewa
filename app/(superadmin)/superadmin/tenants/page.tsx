import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { listTenants } from "@/lib/platform/admin-data";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const metadata = { title: "Clinics" };
export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  active: "bg-ok-tint text-ok", pending: "bg-sunken text-ink-soft", suspended: "bg-alert-tint text-alert", closed: "bg-sunken text-ink-faint",
};

export default async function Clinics() {
  await requireSuperAdmin();
  const rows = await listTenants();
  return (
    <>
      <PageHeader title="Clinics" subtitle="Every clinic on the platform, its status and how long it is paid for." />
      <Panel flush>
        {rows.length === 0 ? <p className="px-5 py-6 text-ink-soft">No clinics yet. Approve an application to create one.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-[0.95rem]">
              <thead className="border-b border-line text-sm text-ink-faint">
                <tr><th className="px-5 py-2.5 font-medium">Clinic</th><th className="py-2.5 font-medium">Status</th><th className="py-2.5 font-medium">Paid until</th><th className="px-5 py-2.5 font-medium">Note</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className="px-5 py-3"><Link href={`/superadmin/tenants/${t.id}`} className="font-medium text-pine hover:underline">{t.name}</Link><div className="text-sm text-ink-faint">/{t.slug}</div></td>
                    <td className="py-3"><span className={cn("rounded-full px-2.5 py-0.5 text-sm font-medium capitalize", STATUS_STYLE[t.status])}>{t.status}</span></td>
                    <td className="py-3 text-ink-soft">{t.paidUntil ?? "no period"}</td>
                    <td className="px-5 py-3 text-sm text-ink-faint">{t.status_reason === "subscription_expired" ? "Subscription expired" : t.status_reason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
