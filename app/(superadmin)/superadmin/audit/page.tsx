import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { serviceClient } from "@/lib/supabase/service";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const metadata = { title: "Platform audit" };
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ktm = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(d);
const box = "rounded-control border border-line-strong px-2 py-1.5";
const OUTCOME = { success: ["Done", "text-ink-soft"], denied: ["Refused", "text-warn"], error: ["Error", "text-alert"] } as const;
const KIND: Record<string, string> = { platform_admin: "Platform admin", system: "System", member: "Clinic staff", patient_account: "Patient", guest_token: "Website visitor" };

type Row = { id: number; created_at: string; tenant_id: string | null; actor_kind: string; actor_id: string | null; action: string; target_type: string | null; outcome: keyof typeof OUTCOME; reason: string | null; patient_id: string | null };

// Platform audit (U2): what platform admins did (approvals, clinic status, plans, invoices,
// settings), what the platform's jobs did, and, per clinic if chosen, the clinic's own log.
// Patient identities are never shown here: the platform has no business knowing them.
export default async function PlatformAudit({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; t?: string; scope?: string; o?: string; before?: string }> }) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const today = ktm(new Date());
  const to = sp.to && DATE.test(sp.to) && sp.to <= today ? sp.to : today;
  const from = sp.from && DATE.test(sp.from) && sp.from <= to ? sp.from : new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  const scope = sp.scope === "all" ? "all" : "platform";
  const outcome = sp.o === "denied" || sp.o === "error" || sp.o === "success" ? sp.o : null;
  const before = Number(sp.before) > 0 ? Number(sp.before) : null;
  const db = serviceClient();
  const { data: tenants } = await db.from("tenants").select("id, name").order("name");
  const tlist = (tenants ?? []) as { id: string; name: string }[];
  const tenant = tlist.find((t) => t.id === sp.t)?.id ?? null;
  let q = db.from("audit_log").select("id, created_at, tenant_id, actor_kind, actor_id, action, target_type, outcome, reason, patient_id")
    .gte("created_at", new Date(`${from}T00:00:00+05:45`).toISOString()).lt("created_at", new Date(Date.parse(`${to}T00:00:00+05:45`) + 86_400_000).toISOString())
    .order("id", { ascending: false }).limit(101);
  if (tenant) q = q.eq("tenant_id", tenant);
  if (scope === "platform") q = q.or("tenant_id.is.null,actor_kind.eq.platform_admin,actor_kind.eq.system");
  if (outcome) q = q.eq("outcome", outcome);
  if (before) q = q.lt("id", before);
  const { data } = await q;
  const raw = (data ?? []) as Row[];
  const rows = raw.slice(0, 100), more = raw.length > 100;
  const adminIds = [...new Set(rows.filter((r) => r.actor_kind === "platform_admin" && r.actor_id).map((r) => r.actor_id!))];
  const memberIds = [...new Set(rows.filter((r) => r.actor_kind === "member" && r.actor_id).map((r) => r.actor_id!))];
  const [a, m] = await Promise.all([
    adminIds.length ? db.from("platform_admins").select("id, display_name").in("id", adminIds) : Promise.resolve({ data: [] }),
    memberIds.length ? db.from("tenant_members").select("id, display_name").in("id", memberIds) : Promise.resolve({ data: [] }),
  ]);
  const names = new Map([...((a.data ?? []) as { id: string; display_name: string }[]), ...((m.data ?? []) as { id: string; display_name: string }[])].map((x) => [x.id, x.display_name]));
  const tname = new Map(tlist.map((t) => [t.id, t.name]));
  const base = new URLSearchParams({ from, to, scope, ...(tenant ? { t: tenant } : {}), ...(outcome ? { o: outcome } : {}) });
  return (
    <>
      <PageHeader title="Platform audit" subtitle="Platform admins' actions and the platform's jobs; choose a clinic to see its own log. Patients are never identified here." />
      <form action="/superadmin/audit" className="mb-5 flex flex-wrap items-end gap-3">
        <label><span className="block text-xs text-ink-faint">From</span><input type="date" name="from" defaultValue={from} max={today} className={box} /></label>
        <label><span className="block text-xs text-ink-faint">To</span><input type="date" name="to" defaultValue={to} max={today} className={box} /></label>
        <label><span className="block text-xs text-ink-faint">Clinic</span><select name="t" defaultValue={tenant ?? ""} className={box}><option value="">All clinics</option>{tlist.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label><span className="block text-xs text-ink-faint">Show</span><select name="scope" defaultValue={scope} className={box}><option value="platform">Platform actions</option><option value="all">Everything</option></select></label>
        <label><span className="block text-xs text-ink-faint">Outcome</span><select name="o" defaultValue={outcome ?? ""} className={box}><option value="">Any</option><option value="denied">Refused</option><option value="error">Error</option><option value="success">Done</option></select></label>
        <button className="rounded-control border border-line-strong px-3 py-1.5">Show</button>
      </form>
      <Panel title={before ? "Older entries" : "Latest entries"} flush>
        {rows.length === 0 ? <p className="px-5 py-4 text-ink-soft">Nothing recorded for these filters.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-[0.92rem]">
              <thead className="text-sm text-ink-faint"><tr><th className="px-5 py-2 font-medium">When</th><th className="py-2 font-medium">Clinic</th><th className="py-2 font-medium">Who</th><th className="py-2 font-medium">What</th><th className="px-5 py-2 font-medium">Outcome</th></tr></thead>
              <tbody className="divide-y divide-line">{rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="whitespace-nowrap px-5 py-2 text-sm">{new Date(r.created_at).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "medium" })}</td>
                  <td className="py-2">{r.tenant_id ? tname.get(r.tenant_id) ?? "—" : "Platform"}</td>
                  <td className="py-2">{r.actor_id ? names.get(r.actor_id) ?? KIND[r.actor_kind] : KIND[r.actor_kind] ?? r.actor_kind}<span className="block text-xs text-ink-faint">{KIND[r.actor_kind]}</span></td>
                  <td className="py-2"><code className="text-sm">{r.action}</code>{r.target_type ? <span className="block text-xs text-ink-faint">{r.target_type.replace(/_/g, " ")}</span> : null}{r.patient_id ? <span className="block text-xs text-ink-faint">a patient record</span> : null}{r.reason ? <span className="block text-xs text-ink-soft">{r.reason}</span> : null}</td>
                  <td className={cn("px-5 py-2 text-sm", OUTCOME[r.outcome][1])}>{OUTCOME[r.outcome][0]}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Panel>
      <div className="mt-4 flex gap-4">
        {before ? <Link href={`/superadmin/audit?${base}`} className="text-pine hover:underline">Back to the latest</Link> : null}
        {more ? <Link href={`/superadmin/audit?${base}&before=${rows[rows.length - 1]!.id}`} className="text-pine hover:underline">Older entries</Link> : null}
      </div>
    </>
  );
}
