import Link from "next/link";
import { getAlerts } from "@/lib/inventory/data";
import { AlertList } from "@/components/inventory/alert-list";
import { getDeskSetup, getToday, todayIn } from "@/lib/desk/data";
import { PageHeader, Panel, ButtonLink } from "@/components/ui/primitives";
import { can } from "@/lib/auth/context";
import { financeReport, lastFinanceCheck, profitAndLoss } from "@/lib/finance/data";
import { serviceClient } from "@/lib/supabase/service";
import { LiveRefresh } from "@/components/notify/live-refresh";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { requireTenant } from "@/lib/auth/context";
import { BLOCKER_LABELS, getSetupStatus } from "@/lib/tenant/setup-data";
import { GoLiveButton } from "@/components/platform/go-live-button";

export const metadata = { title: "Dashboard" };

export const dynamic = "force-dynamic";

export default async function AdminDashboard() {
  const ctx = await requireTenant({ operation: "admin.area", allowPendingTenant: true, next: "/admin" });
  const { items: SETUP, blockers } = await getSetupStatus(ctx.tenantId);
  const setupDone = SETUP.filter((s) => s.done).length;
  const pending = ctx.tenantStatus === "pending";
  const today = todayIn();
  const money = can(ctx, "view_finance") || can(ctx, "view_reports");
  const [{ doctors }, board, alerts, fin, pl, check, requests] = await Promise.all([
    getDeskSetup(ctx.tenantId), getToday(ctx.tenantId, today), getAlerts(ctx.tenantId),
    money ? financeReport(ctx.tenantId, today, today) : Promise.resolve(null),
    money ? profitAndLoss(ctx.tenantId, null, today, today) : Promise.resolve(null),
    can(ctx, "view_finance") ? lastFinanceCheck(ctx.tenantId) : Promise.resolve(null),
    serviceClient().from("appointments").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenantId).eq("status", "requested"),
  ]);
  const received = (fin?.money ?? []).find((m) => m.kind === "payment");
  const live = board.visits.filter((v) => v.status !== "cancelled");
  const flow = {
    booked: board.appointments.filter((a) => !["cancelled"].includes(a.status)).length,
    arrived: live.length,
    waiting: live.filter((v) => v.status === "waiting").length,
    done: live.filter((v) => ["closed", "awaiting_billing"].includes(v.status)).length,
  };
  const dateLine = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
  return (
    <>
      <LiveRefresh topics={["queue", "bookings", "billing", "stock"]} />
      <PageHeader
        title="Today at the clinic"
        subtitle={dateLine}
        actions={<ButtonLink href="/employee/registrar" tone="secondary">Open registrar desk</ButtonLink>}
      />
      {pending ? (
        <section aria-label="Getting ready" className="mb-6 rounded-panel border border-pine/40 bg-surface p-5">
          <h2 className="text-lg font-semibold">Get {ctx.tenantName} ready to go live</h2>
          <p className="mt-1 text-ink-soft">Patients can&apos;t book and your website stays private until you go live.</p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {SETUP.map((s) => (
              <li key={s.label} className="flex items-center gap-2.5">
                <Icon name={s.done ? "CheckCircle2" : "Clock"} className={cn("size-4", s.done ? "text-ok" : s.required ? "text-warn" : "text-ink-faint")} />
                <Link href={s.href} className={s.done ? "text-ink-soft line-through decoration-line-strong" : "underline-offset-2 hover:underline"}>{s.label}</Link>
                {!s.done && s.required ? <span className="text-xs text-warn">needed</span> : null}
              </li>
            ))}
          </ul>
          {blockers.length ? (
            <p className="mt-4 text-sm text-ink-soft">Still needed: {blockers.map((b) => BLOCKER_LABELS[b]?.label ?? b).join("; ")}.</p>
          ) : null}
          {ctx.membershipRole === "tenant_admin" ? <div className="mt-4"><GoLiveButton ready={blockers.length === 0} /></div> : null}
        </section>
      ) : null}
      {/* Patients flow, written as one sentence-like line rather than four look-alike tiles. */}
      <section aria-label="Patients today" className="mb-6 flex flex-wrap items-baseline gap-x-8 gap-y-2 border-y border-line py-4">
        <Figure value={flow.booked} label="booked" />
        <Figure value={flow.arrived} label="registered" />
        <Figure value={flow.waiting} label="waiting now" emphasis />
        <Figure value={flow.done} label="seen" />
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <Panel title="OPD queues" aside={<Link className="text-sm font-medium text-pine hover:underline" href="/employee/registrar">Registrar view</Link>} flush>
            <ul className="divide-y divide-line">
              {doctors.length === 0 ? <li className="px-5 py-4 text-ink-soft">No doctors set up yet.</li> : null}
              {doctors.map((d) => {
                const q = live.filter((v) => v.doctorId === d.id);
                const now = q.find((v) => v.status === "with_doctor");
                const waiting = q.filter((v) => v.status === "waiting").length;
                return (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3.5">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{d.name}</div>
                      <div className="text-sm text-ink-faint">{[d.specialty, d.room].filter(Boolean).join(", ")}</div>
                    </div>
                    <div className="text-sm text-ink-soft">
                      {now ? <>Seeing token <span className="rounded bg-marigold-tint px-1.5 font-semibold text-marigold-ink">{now.token}</span></> : "Not started"}
                    </div>
                    <div className="w-24 text-right text-sm text-ink-soft">{waiting} waiting</div>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <Panel title="Stock that needs attention" aside={<Link className="text-sm font-medium text-pine hover:underline" href="/admin/stock">Stock & stores</Link>} flush>
            <AlertList alerts={alerts} showStore limit={8} />
          </Panel>
        </div>

        <div className="space-y-6">
          {fin && pl ? (
            <Panel title="Money today" aside={can(ctx, "view_finance") ? <Link className="text-sm font-medium text-pine hover:underline" href="/admin/finance">Finance</Link> : null}>
              <dl className="grid grid-cols-[1fr_auto] gap-y-2.5 text-[0.95rem]">
                <dt className="text-ink-soft">OPD and services</dt><dd className="text-right tabular-nums">{npr(Number(pl.revenue_services))}</dd>
                <dt className="text-ink-soft">Pharmacy</dt><dd className="text-right tabular-nums">{npr(Number(pl.revenue_pharmacy))}</dd>
                <dt className="border-t border-line pt-2.5 font-semibold">Sales (before VAT)</dt>
                <dd className="border-t border-line pt-2.5 text-right font-semibold tabular-nums">{npr(Number(pl.revenue))}</dd>
                <dt className="pt-3 text-ink-soft">Cash received</dt><dd className="pt-3 text-right tabular-nums">{npr(Number(received?.cash_in ?? 0) - Number(received?.cash_out ?? 0))}</dd>
                <dt className="text-ink-soft">Online received</dt><dd className="text-right tabular-nums">{npr(Number(received?.bank_in ?? 0) - Number(received?.bank_out ?? 0))}</dd>
                <dt className="text-ink-soft">Owed by patients</dt><dd className={cn("text-right tabular-nums", Number(fin.balances.AR_PATIENTS.closing) > 0 && "text-warn")}>{npr(Number(fin.balances.AR_PATIENTS.closing))}</dd>
                <dt className="text-ink-soft">Owed to vendors</dt><dd className="text-right tabular-nums">{npr(Number(fin.balances.AP_VENDORS.closing))}</dd>
              </dl>
            </Panel>
          ) : null}

          <Panel title="Also today">
            <ul className="space-y-2 text-[0.95rem]">
              <li><Link href="/employee/registrar" className="hover:underline">{requests.count ?? 0} website booking request{requests.count === 1 ? "" : "s"} waiting</Link></li>
              {check ? <li className={check.mismatches ? "text-alert" : "text-ink-soft"}><Link href="/admin/finance" className="hover:underline">{check.mismatches ? `Books check: ${check.mismatches} figure(s) differ` : "Books check: everything matches"}</Link></li> : null}
              <li><Link href="/employee/notifications" className="hover:underline">Your notifications</Link></li>
            </ul>
          </Panel>

          <Panel title="Setting up" aside={<span className="text-sm text-ink-faint">{setupDone} of {SETUP.length}</span>}>
            <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={SETUP.length} aria-valuenow={setupDone}>
              <div className="h-full bg-pine" style={{ width: `${(setupDone / SETUP.length) * 100}%` }} />
            </div>
            <ul className="space-y-2">
              {SETUP.map((s) => (
                <li key={s.label} className="flex items-center gap-2.5">
                  <Icon name={s.done ? "CheckCircle2" : "Clock"} className={cn("size-4", s.done ? "text-ok" : "text-ink-faint")} />
                  <Link href={s.href} className={s.done ? "text-ink-soft line-through decoration-line-strong" : "hover:underline"}>{s.label}</Link>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}

function Figure({ value, label, emphasis }: { value: number; label: string; emphasis?: boolean }) {
  return (
    <p className="flex items-baseline gap-2">
      <span className={cn("text-3xl font-semibold", emphasis && "text-pine")}>{value}</span>
      <span className="text-ink-soft">{label}</span>
    </p>
  );
}
