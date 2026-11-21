import { requireTenant, can } from "@/lib/auth/context";
import { getDeskSetup, getToday, listBookingRequests, todayIn } from "@/lib/desk/data";
import { patientsWithDues } from "@/lib/pharmacy/data";
import { serviceClient } from "@/lib/supabase/service";
import { BookingRequests } from "@/components/desk/booking-requests";
import { CollectDues } from "@/components/pharmacy/bill-corrections";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { RegistrarDesk } from "@/components/desk/registrar-desk";
import { LiveRefresh } from "@/components/notify/live-refresh";

export const dynamic = "force-dynamic";
export const metadata = { title: "Registrar" };

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// The front desk (W-10..W-13): find or register the patient → check in with the OPD fee and
// payment → token and receipt; book, reschedule or cancel; today's appointments and every
// doctor's queue; print prescriptions (print_prescriptions); collect dues (manage_billing).
export default async function RegistrarDeskPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await requireTenant({ operation: "front_desk.operate", permission: "view_queue", next: "/employee/registrar" });
  const sp = await searchParams;
  const today = todayIn();
  const canCollect = can(ctx, "manage_billing");
  const [setup, board, requests, rx, dues] = await Promise.all([
    getDeskSetup(ctx.tenantId), getToday(ctx.tenantId, today),
    can(ctx, "view_appointments") ? listBookingRequests(ctx.tenantId) : Promise.resolve([]),
    can(ctx, "print_prescriptions") ? serviceClient().rpc("visit_prescriptions", { p_tenant: ctx.tenantId, p_member: ctx.memberId, p_day: today }) : Promise.resolve({ data: [] }),
    canCollect ? patientsWithDues(ctx.tenantId) : Promise.resolve([]),
  ]);
  const rxByVisit = Object.fromEntries(((rx.data ?? []) as { visit_id: string; prescription_id: string; rx_number: string }[]).map((r) => [r.visit_id, { id: r.prescription_id, no: r.rx_number }]));
  const renderedAt = new Date();
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", weekday: "long", day: "numeric", month: "long" }).format(renderedAt);
  return (
    <>
      <LiveRefresh topics={["queue", "bookings", "billing"]} />
      <PageHeader title="Registrar" subtitle={`${fmt}. ${board.visits.filter((v) => v.status !== "cancelled").length} checked in, ${board.appointments.filter((a) => a.status === "confirmed").length} still expected.`} />
      <BookingRequests requests={requests} canAct={can(ctx, "manage_appointments") && can(ctx, "manage_patients")} />
      {setup.doctors.length === 0 ? (
        <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">No doctors are set up yet. An admin adds them in Admin, Doctors &amp; schedules.</p>
      ) : (
        <RegistrarDesk
          today={today} now={renderedAt.getTime()} doctors={setup.doctors} services={setup.services} settings={setup.settings}
          visits={board.visits} appointments={board.appointments} rxByVisit={rxByVisit} initialQuery={String(sp.q ?? "").slice(0, 60)}
          can={{
            register: can(ctx, "manage_patients"), book: can(ctx, "manage_appointments"),
            checkIn: can(ctx, "manage_queue") && (setup.settings.billingPoint !== "check_in" || can(ctx, "manage_billing")),
            cancel: can(ctx, "manage_queue"),
          }}
        />
      )}
      {dues.length ? (
        <Panel title="Patients who owe" aside={<span className="text-sm text-ink-faint">{npr(dues.reduce((s, d) => s + d.owed, 0))}</span>} flush className="mt-6">
          <ul className="divide-y divide-line">{dues.map((d) => (
            <li key={d.patient_id} className="grid gap-3 px-5 py-3 lg:grid-cols-[1fr_auto]">
              <div><span className="font-medium">{d.name}</span> <span className="text-sm text-ink-faint">{d.mrn}{d.phone ? `, ${d.phone}` : ""}</span>
                <div className="text-sm text-ink-soft">Owes {npr(d.owed)} on {d.bills} bill{d.bills > 1 ? "s" : ""}</div></div>
              <CollectDues key={`${d.patient_id}:${d.owed}`} patientId={d.patient_id} owed={d.owed} />
            </li>))}</ul>
        </Panel>
      ) : null}
    </>
  );
}
