import Link from "next/link";
import { DEMO_CLINIC, DEMO_DOCTORS, DEMO_QUEUE, DEMO_STOCK_ALERTS, DEMO_TODAY, npr } from "@/lib/demo";
import { DemoNotice, PageHeader, Panel, ButtonLink } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { requireTenant } from "@/lib/auth/context";
import { BLOCKER_LABELS, getSetupStatus } from "@/lib/tenant/setup-data";
import { GoLiveButton } from "@/components/platform/go-live-button";

export const metadata = { title: "Dashboard" };

const ALERT_STYLE = {
  expired: { cls: "text-alert", label: "Expired" },
  near_expiry: { cls: "text-warn", label: "Near expiry" },
  low: { cls: "text-ink-soft", label: "Low stock" },
} as const;

export const dynamic = "force-dynamic";

export default async function AdminDashboard() {
  const ctx = await requireTenant({ operation: "admin.area", allowPendingTenant: true, next: "/admin" });
  const t = DEMO_TODAY;
  const { items: SETUP, blockers } = await getSetupStatus(ctx.tenantId);
  const setupDone = SETUP.filter((s) => s.done).length;
  const pending = ctx.tenantStatus === "pending";
  return (
    <>
      <PageHeader
        title="Today at the clinic"
        subtitle={`${DEMO_CLINIC.todayBs} · ${DEMO_CLINIC.todayAd}`}
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
      <DemoNotice />

      {/* Patients flow, written as one sentence-like line rather than four look-alike tiles. */}
      <section aria-label="Patients today" className="mb-6 flex flex-wrap items-baseline gap-x-8 gap-y-2 border-y border-line py-4">
        <Figure value={t.booked} label="booked" />
        <Figure value={t.arrived} label="registered" />
        <Figure value={t.waiting} label="waiting now" emphasis />
        <Figure value={t.done} label="seen" />
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <Panel title="OPD queues" aside={<Link className="text-sm font-medium text-pine hover:underline" href="/employee/registrar">Registrar view</Link>} flush>
            <ul className="divide-y divide-line">
              {DEMO_DOCTORS.map((d) => {
                const q = DEMO_QUEUE.filter((v) => v.doctorId === d.id);
                const now = q.find((v) => v.status === "with_doctor");
                const waiting = q.filter((v) => v.status === "waiting").length;
                return (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3.5">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{d.name}</div>
                      <div className="text-sm text-ink-faint">{d.specialty} · {d.room}</div>
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
            <ul className="divide-y divide-line">
              {DEMO_STOCK_ALERTS.map((a) => (
                <li key={a.item} className="flex gap-4 px-5 py-3">
                  <span className={cn("w-24 shrink-0 text-sm font-medium", ALERT_STYLE[a.kind].cls)}>{ALERT_STYLE[a.kind].label}</span>
                  <div className="min-w-0">
                    <div className="font-medium">{a.item}</div>
                    <div className="text-sm text-ink-faint">{a.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Money today">
            <dl className="grid grid-cols-[1fr_auto] gap-y-2.5 text-[0.95rem]">
              <dt className="text-ink-soft">OPD and services</dt><dd className="text-right">{npr(t.opdRevenue)}</dd>
              <dt className="text-ink-soft">Pharmacy</dt><dd className="text-right">{npr(t.pharmacyRevenue)}</dd>
              <dt className="border-t border-line pt-2.5 font-semibold">Sales</dt>
              <dd className="border-t border-line pt-2.5 text-right font-semibold">{npr(t.opdRevenue + t.pharmacyRevenue)}</dd>
              <dt className="pt-3 text-ink-soft">Cash received</dt><dd className="pt-3 text-right">{npr(t.cash)}</dd>
              <dt className="text-ink-soft">Online received</dt><dd className="text-right">{npr(t.online)}</dd>
              <dt className="text-ink-soft">Patient dues (total)</dt><dd className="text-right text-warn">{npr(t.dues)}</dd>
              <dt className="text-ink-soft">Owed to vendors</dt><dd className="text-right">{npr(t.payables)}</dd>
            </dl>
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
