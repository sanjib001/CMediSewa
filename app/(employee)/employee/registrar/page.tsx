import { requireTenant, can } from "@/lib/auth/context";
import { getDeskSetup, getToday, listBookingRequests, todayIn } from "@/lib/desk/data";
import { BookingRequests } from "@/components/desk/booking-requests";
import { PageHeader } from "@/components/ui/primitives";
import { RegistrarDesk } from "@/components/desk/registrar-desk";

export const dynamic = "force-dynamic";
export const metadata = { title: "Registrar" };

// The front desk (W-10..W-13): find or register the patient → check in with the OPD fee and
// payment → token; book for later; today's appointments and every doctor's queue.
export default async function RegistrarDeskPage() {
  const ctx = await requireTenant({ operation: "front_desk.operate", permission: "view_queue", next: "/employee/registrar" });
  const today = todayIn();
  const [setup, board, requests] = await Promise.all([getDeskSetup(ctx.tenantId), getToday(ctx.tenantId, today), can(ctx, "view_appointments") ? listBookingRequests(ctx.tenantId) : Promise.resolve([])]);
  const renderedAt = new Date();
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", weekday: "long", day: "numeric", month: "long" }).format(renderedAt);
  return (
    <>
      <PageHeader title="Registrar" subtitle={`${fmt}. ${board.visits.filter((v) => v.status !== "cancelled").length} checked in, ${board.appointments.filter((a) => a.status === "confirmed").length} still expected.`} />
      <BookingRequests requests={requests} canAct={can(ctx, "manage_appointments") && can(ctx, "manage_patients")} />
      {setup.doctors.length === 0 ? (
        <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">No doctors are set up yet. An admin adds them in Admin, Doctors &amp; schedules.</p>
      ) : (
        <RegistrarDesk
          today={today} now={renderedAt.getTime()} doctors={setup.doctors} services={setup.services} settings={setup.settings}
          visits={board.visits} appointments={board.appointments}
          can={{
            register: can(ctx, "manage_patients"), book: can(ctx, "manage_appointments"),
            checkIn: can(ctx, "manage_queue") && (setup.settings.billingPoint !== "check_in" || can(ctx, "manage_billing")),
            cancel: can(ctx, "manage_queue"),
          }}
        />
      )}
    </>
  );
}
