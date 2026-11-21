import Link from "next/link";
import { requireTenant } from "@/lib/auth/context";
import { AUDIT_GROUPS, auditMembers, listAudit, type AuditGroup } from "@/lib/audit-view";
import { todayIn } from "@/lib/desk/data";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const box = "rounded-control border border-line-strong px-2 py-1.5";
const OUTCOME = { success: { t: "Done", c: "text-ink-soft" }, denied: { t: "Refused", c: "text-warn" }, error: { t: "Error", c: "text-alert" } } as const;

// Audit log (U3, view_audit_log): who did what and when (sign-ins, chart reads, money and stock
// corrections, setup changes), newest first, 100 at a time. Read-only; nothing here can be edited.
export default async function Audit({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; g?: string; o?: string; m?: string; before?: string }> }) {
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_audit_log", allowPendingTenant: true, next: "/admin/audit" });
  const sp = await searchParams;
  const today = todayIn();
  const to = sp.to && DATE.test(sp.to) && sp.to <= today ? sp.to : today;
  const from = sp.from && DATE.test(sp.from) && sp.from <= to ? sp.from : shift(to, -6);
  const group = sp.g && sp.g in AUDIT_GROUPS ? (sp.g as AuditGroup) : null;
  const outcome = sp.o === "success" || sp.o === "denied" || sp.o === "error" ? sp.o : null;
  const members = await auditMembers(ctx.tenantId);
  const member = members.some((x) => x.id === sp.m) ? sp.m! : null;
  const before = Number(sp.before) > 0 ? Number(sp.before) : null;
  const { rows, more, next } = await listAudit(ctx.tenantId, { from, to, group, outcome, member, before });
  const base = new URLSearchParams({ from, to, ...(group ? { g: group } : {}), ...(outcome ? { o: outcome } : {}), ...(member ? { m: member } : {}) });
  return (
    <>
      <PageHeader title="Audit log" subtitle="Who did what, and when. Chart reads are listed by patient number; what was in the record never is." />
      <form action="/admin/audit" className="mb-5 flex flex-wrap items-end gap-3">
        <label><span className="block text-xs text-ink-faint">From</span><input type="date" name="from" defaultValue={from} max={today} className={box} /></label>
        <label><span className="block text-xs text-ink-faint">To</span><input type="date" name="to" defaultValue={to} max={today} className={box} /></label>
        <label><span className="block text-xs text-ink-faint">Kind</span><select name="g" defaultValue={group ?? ""} className={box}><option value="">Everything</option>
          {(Object.keys(AUDIT_GROUPS) as AuditGroup[]).map((g) => <option key={g} value={g}>{AUDIT_GROUPS[g].label}</option>)}</select></label>
        <label><span className="block text-xs text-ink-faint">Person</span><select name="m" defaultValue={member ?? ""} className={box}><option value="">Anyone</option>
          {members.map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}</select></label>
        <label><span className="block text-xs text-ink-faint">Outcome</span><select name="o" defaultValue={outcome ?? ""} className={box}><option value="">Any</option>
          <option value="denied">Refused</option><option value="error">Error</option><option value="success">Done</option></select></label>
        <button className="rounded-control border border-line-strong px-3 py-1.5">Show</button>
      </form>
      <Panel title={before ? "Older entries" : "Latest entries"} flush>
        {rows.length === 0 ? <p className="px-5 py-4 text-ink-soft">Nothing recorded for these filters.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-[0.92rem]">
              <thead className="text-sm text-ink-faint"><tr><th className="px-5 py-2 font-medium">When</th><th className="py-2 font-medium">Who</th><th className="py-2 font-medium">What</th><th className="py-2 font-medium">Outcome</th><th className="px-5 py-2 font-medium">Details</th></tr></thead>
              <tbody className="divide-y divide-line">{rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="whitespace-nowrap px-5 py-2 text-sm">{new Date(r.at).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "medium" })}</td>
                  <td className="py-2">{r.who}{r.level ? <span className="block text-xs text-ink-faint">{r.level === "A1" ? "PIN" : r.level === "A2" ? "password" : "password + code"}</span> : null}</td>
                  <td className="py-2"><code className="text-sm">{r.action}</code>{r.target ? <span className="block text-xs text-ink-faint">{r.target}</span> : null}{r.patient ? <span className="block text-xs text-ink-faint">patient {r.patient}</span> : null}</td>
                  <td className={cn("py-2 text-sm", OUTCOME[r.outcome].c)}>{OUTCOME[r.outcome].t}</td>
                  <td className="px-5 py-2 text-sm text-ink-soft">{[r.reason, r.detail].filter(Boolean).join(" · ") || "—"}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Panel>
      <div className="mt-4 flex gap-4">
        {before ? <Link href={`/admin/audit?${base}`} className="text-pine hover:underline">Back to the latest</Link> : null}
        {more && next ? <Link href={`/admin/audit?${base}&before=${next}`} className="text-pine hover:underline">Older entries</Link> : null}
      </div>
    </>
  );
}
