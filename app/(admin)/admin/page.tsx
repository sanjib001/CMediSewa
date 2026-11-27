import Link from "next/link";
import { getAlerts, type StockAlert } from "@/lib/inventory/data";
import { getDeskSetup, getToday, todayIn } from "@/lib/desk/data";
import { patientsWithDues } from "@/lib/pharmacy/data";
import { Panel, ButtonLink } from "@/components/ui/primitives";
import { can, requireTenant } from "@/lib/auth/context";
import { financeReport, lastFinanceCheck, profitAndLoss } from "@/lib/finance/data";
import { serviceClient } from "@/lib/supabase/service";
import { LiveRefresh } from "@/components/notify/live-refresh";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { adToBs, formatBs, localDate } from "@/lib/clinic-time";
import { BLOCKER_LABELS, getSetupStatus } from "@/lib/tenant/setup-data";
import { GoLiveButton } from "@/components/platform/go-live-button";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Need = { tone: "alert" | "warn" | "plain"; text: string; href: string; action: string };

// The owner's day at a glance (D-156). The BS date leads; the patient flow is drawn as the
// sequence it is; "Needs you" gathers what to act on, counted rather than listed batch by batch;
// OPD queues show the token being served. Every part follows its own key (D-153).
export default async function AdminDashboard() {
  const ctx = await requireTenant({ operation: "admin.area", allowPendingTenant: true, next: "/admin" });
  const seesSetup = ctx.membershipRole === "tenant_admin" || can(ctx, "manage_settings");
  const seesDesk = can(ctx, "view_queue") || can(ctx, "view_appointments");
  const seesRequests = can(ctx, "view_appointments") || can(ctx, "manage_appointments");
  const seesStock = can(ctx, "view_stock");
  const seesDues = can(ctx, "view_billing");
  const money = can(ctx, "view_finance") || can(ctx, "view_reports");
  const today = todayIn();
  const [setup, desk, board, alerts, fin, pl, check, requests, dues] = await Promise.all([
    seesSetup ? getSetupStatus(ctx.tenantId) : Promise.resolve({ items: [], blockers: [] }),
    seesDesk ? getDeskSetup(ctx.tenantId) : Promise.resolve(null),
    seesDesk ? getToday(ctx.tenantId, today) : Promise.resolve(null),
    seesStock ? getAlerts(ctx.tenantId) : Promise.resolve([] as StockAlert[]),
    money ? financeReport(ctx.tenantId, today, today) : Promise.resolve(null),
    money ? profitAndLoss(ctx.tenantId, null, today, today) : Promise.resolve(null),
    can(ctx, "view_finance") ? lastFinanceCheck(ctx.tenantId) : Promise.resolve(null),
    seesRequests ? serviceClient().from("appointments").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenantId).eq("status", "requested") : Promise.resolve({ count: 0 }),
    seesDues ? patientsWithDues(ctx.tenantId) : Promise.resolve([]),
  ]);
  const { items: SETUP, blockers } = setup;
  const setupDone = SETUP.filter((s) => s.done).length;
  const pending = ctx.tenantStatus === "pending" && seesSetup;
  const showSetup = seesSetup && SETUP.length > 0 && setupDone < SETUP.length;

  const live = (board?.visits ?? []).filter((v) => v.status !== "cancelled");
  const flow = [
    { n: (board?.appointments ?? []).filter((a) => a.status !== "cancelled").length, label: "booked" },
    { n: live.length, label: "registered" },
    { n: live.filter((v) => v.status === "waiting").length, label: "waiting now", now: true },
    { n: live.filter((v) => ["closed", "awaiting_billing"].includes(v.status)).length, label: "seen" },
  ];

  // What needs someone today, most urgent first.
  const count = (k: StockAlert["kind"]) => alerts.filter((a) => a.kind === k).length;
  const owed = dues.reduce((s, d) => s + d.owed, 0);
  const needs: Need[] = [];
  if ((requests.count ?? 0) > 0) needs.push({ tone: "warn", text: `${plural(requests.count ?? 0, "website booking request")} to confirm`, href: "/employee/registrar", action: "Confirm" });
  if (count("expired") + count("blocked")) needs.push({ tone: "alert", text: `${plural(count("expired") + count("blocked"), "batch", "batches")} expired or recalled still on the shelf`, href: "/admin/stock", action: "Move to quarantine" });
  if (count("critical_stock")) needs.push({ tone: "alert", text: `${plural(count("critical_stock"), "medicine")} below the minimum`, href: "/admin/stock/reorder", action: "Reorder" });
  if (count("near_expiry")) needs.push({ tone: "warn", text: `${plural(count("near_expiry"), "batch", "batches")} expiring soon`, href: "/admin/stock", action: "See batches" });
  if (count("low_stock")) needs.push({ tone: "plain", text: `${plural(count("low_stock"), "medicine")} at the reorder level`, href: "/admin/stock/reorder", action: "Reorder" });
  if (owed > 0) needs.push({ tone: "plain", text: `${npr(owed)} owed by ${plural(dues.length, "patient")}`, href: "/admin/billing", action: "Collect" });
  if (check?.mismatches) needs.push({ tone: "alert", text: `Books check: ${plural(check.mismatches, "figure")} differ`, href: "/admin/finance", action: "Review" });

  const at = new Date();
  const [bsYear, bsMonth, bsDay] = formatBs(adToBs(localDate(at))).split(" ");
  const weekday = at.toLocaleDateString("en-GB", { timeZone: "Asia/Kathmandu", weekday: "long" });
  const ad = at.toLocaleDateString("en-GB", { timeZone: "Asia/Kathmandu", day: "numeric", month: "long", year: "numeric" });
  const received = (fin?.money ?? []).find((m) => m.kind === "payment");
  const cashIn = Number(received?.cash_in ?? 0) - Number(received?.cash_out ?? 0);
  const onlineIn = Number(received?.bank_in ?? 0) - Number(received?.bank_out ?? 0);

  return (
    <>
      <LiveRefresh topics={["queue", "bookings", "billing", "stock"]} />
      {/* The BS date is the page's one bold moment: the day the clinic counts in. */}
      <header className="flex flex-wrap items-end justify-between gap-3 pb-5">
        <div>
          <h1 className="text-[2.25rem] font-semibold leading-none tracking-[-0.015em]">{bsMonth} {bsDay}<span className="font-normal text-ink-soft">, {weekday}</span></h1>
          <p className="mt-2 text-ink-soft">{bsYear} BS, {ad}</p>
        </div>
        {can(ctx, "view_queue") ? <ButtonLink href="/employee/registrar" tone="secondary">Open registrar desk</ButtonLink> : null}
      </header>

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
          {blockers.length ? <p className="mt-4 text-sm text-ink-soft">Still needed: {blockers.map((b) => BLOCKER_LABELS[b]?.label ?? b).join("; ")}.</p> : null}
          {ctx.membershipRole === "tenant_admin" ? <div className="mt-4"><GoLiveButton ready={blockers.length === 0} /></div> : null}
        </section>
      ) : null}

      {seesDesk || pl ? (
        <section aria-label="Patients today" className="mb-6 flex flex-wrap items-end justify-between gap-x-10 gap-y-4 border-y border-line py-5">
          {seesDesk ? (
            <ol className="day-flow" aria-label="Patients today, in order">
              {flow.map((f) => (
                <li key={f.label} className={cn("day-flow-stop", f.now && "day-flow-now")}>
                  <span className="day-flow-n">{f.n}</span><span className="day-flow-label">{f.label}</span>
                </li>
              ))}
            </ol>
          ) : <span />}
          {pl ? (
            <p className="sm:text-right"><span className="block text-[1.75rem] font-semibold leading-none tabular-nums">{npr(Number(pl.revenue))}</span>
              <span className="text-sm text-ink-soft">sales today, before VAT</span></p>
          ) : null}
        </section>
      ) : null}

      <div className={cn("grid grid-cols-1 gap-6", (fin && pl) || showSetup ? "xl:grid-cols-[1.35fr_1fr]" : "max-w-3xl")}>
        <div className="space-y-6">
          {seesRequests || seesStock || seesDues || check ? (
            <Panel title="Needs you" aside={needs.length ? <span className="text-sm text-ink-faint">{plural(needs.length, "thing")}</span> : null} flush>
              {needs.length === 0 ? (
                <p className="flex items-center gap-2 px-5 py-4 text-ink-soft"><Icon name="CheckCircle2" className="size-4 text-ok" />Nothing needs you right now.</p>
              ) : (
                <ul className="divide-y divide-line">{needs.map((x) => (
                  <li key={x.text} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                    <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", x.tone === "alert" ? "bg-alert" : x.tone === "warn" ? "bg-warn" : "bg-line-strong")} />
                    <span className="min-w-0 flex-1">{x.text}</span>
                    <Link href={x.href} className="text-sm font-medium text-pine hover:underline">{x.action}</Link>
                  </li>))}</ul>
              )}
            </Panel>
          ) : null}

          {seesDesk ? (
            <Panel title="OPD queues" aside={can(ctx, "view_queue") ? <Link className="text-sm font-medium text-pine hover:underline" href="/employee/registrar">Registrar view</Link> : null} flush>
              <ul className="divide-y divide-line">
                {(desk?.doctors ?? []).length === 0 ? <li className="px-5 py-4 text-ink-soft">No doctors set up yet.</li> : null}
                {(desk?.doctors ?? []).map((d) => {
                  const q = live.filter((v) => v.doctorId === d.id);
                  const now = q.find((v) => v.status === "with_doctor");
                  const waiting = q.filter((v) => v.status === "waiting").length;
                  const seen = q.filter((v) => ["closed", "awaiting_billing"].includes(v.status)).length;
                  return (
                    <li key={d.id} className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 py-3.5">
                      <span className={cn("grid h-9 min-w-12 place-items-center rounded-control px-2 text-lg font-semibold tabular-nums",
                        now ? "bg-marigold-tint text-marigold-ink" : "bg-sunken text-ink-faint")} title={now ? "Token being seen now" : "Nobody with the doctor"}>{now ? now.token : "–"}</span>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{d.name}</div>
                        <div className="text-sm text-ink-faint">{[d.specialty, d.room].filter(Boolean).join(", ") || "OPD"}</div>
                      </div>
                      <div className="text-sm text-ink-soft">{now ? "Seeing a patient" : q.length ? "Between patients" : "Not started"}</div>
                      <div className="w-36 text-right text-sm"><span className={cn("font-medium", waiting > 3 && "text-warn")}>{waiting} waiting</span><span className="text-ink-faint">, {seen} seen</span></div>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          ) : null}
        </div>

        <div className="space-y-6">
          {fin && pl ? (
            <Panel title="Money today" aside={can(ctx, "view_finance") ? <Link className="text-sm font-medium text-pine hover:underline" href="/admin/finance">Finance</Link> : null}>
              <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-[0.95rem] tabular-nums">
                <dt className="text-ink-soft">OPD and services</dt><dd className="text-right">{npr(Number(pl.revenue_services))}</dd>
                <dt className="text-ink-soft">Pharmacy</dt><dd className="text-right">{npr(Number(pl.revenue_pharmacy))}</dd>
                <dt className="mt-3 border-t border-line pt-3 text-ink-soft">Cash received</dt><dd className="mt-3 border-t border-line pt-3 text-right">{npr(cashIn)}</dd>
                <dt className="text-ink-soft">Online received</dt><dd className="text-right">{npr(onlineIn)}</dd>
                <dt className="mt-3 border-t border-line pt-3 text-ink-soft">Owed by patients</dt><dd className={cn("mt-3 border-t border-line pt-3 text-right", Number(fin.balances.AR_PATIENTS.closing) > 0 && "text-warn")}>{npr(Number(fin.balances.AR_PATIENTS.closing))}</dd>
                <dt className="text-ink-soft">Owed to vendors</dt><dd className="text-right">{npr(Number(fin.balances.AP_VENDORS.closing))}</dd>
              </dl>
              {check && !check.mismatches ? <p className="mt-4 flex items-center gap-2 text-sm text-ink-faint"><Icon name="CheckCircle2" className="size-4 text-ok" />Books check: everything matches</p> : null}
            </Panel>
          ) : null}

          {showSetup ? (
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
          ) : null}

        </div>
      </div>
    </>
  );
}
