import { requireTenant, can } from "@/lib/auth/context";
import { getToday, listBookingRequests, todayIn } from "@/lib/desk/data";
import { serviceClient } from "@/lib/supabase/service";
import { BookingRequests } from "@/components/desk/booking-requests";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Appointments" };
export const dynamic = "force-dynamic";

const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const STATUS: Record<string, string> = { confirmed: "Booked", checked_in: "Arrived", in_consultation: "With doctor", completed: "Done", cancelled: "Cancelled", no_show: "No-show" };

// Admin view of appointments: website requests waiting for review (D-82), and what's booked
// for the coming days. The registrar sees the same requests on the desk.
export default async function Appointments() {
  const ctx = await requireTenant({ operation: "admin.area", permission: "view_appointments", allowPendingTenant: true, next: "/admin/appointments" });
  const today = todayIn();
  const [requests, board] = await Promise.all([listBookingRequests(ctx.tenantId), getToday(ctx.tenantId, today)]);
  const db = serviceClient();
  const { data } = await db.from("appointments").select("id, doctor_member_id, patient_id, scheduled_range, status, source").eq("tenant_id", ctx.tenantId)
    .gt("appointment_date", today).in("status", ["confirmed"]).not("patient_id", "is", null).order("appointment_date").limit(100);
  const upcoming = (data ?? []) as { id: string; doctor_member_id: string; patient_id: string; scheduled_range: string; status: string; source: string }[];
  const ids = [...new Set([...upcoming.map((u) => u.patient_id), ...upcoming.map((u) => u.doctor_member_id)])];
  const [{ data: pats }, { data: mems }] = await Promise.all([
    ids.length ? db.from("patients").select("id, full_name, mrn").eq("tenant_id", ctx.tenantId).in("id", ids) : Promise.resolve({ data: [] }),
    ids.length ? db.from("tenant_members").select("id, display_name").eq("tenant_id", ctx.tenantId).in("id", ids) : Promise.resolve({ data: [] }),
  ]);
  const name = (id: string) => ((pats ?? []) as { id: string; full_name: string; mrn: string }[]).find((p) => p.id === id);
  const doc = (id: string) => ((mems ?? []) as { id: string; display_name: string }[]).find((m) => m.id === id)?.display_name ?? "";
  const startOf = (r: string) => new Date(r.match(/^[[(]"?([^",]+)/)![1]!).toISOString();

  return (
    <>
      <PageHeader title="Appointments" subtitle="Website booking requests and upcoming appointments." />
      {requests.length === 0 ? <p className="mb-6 rounded-panel border border-line bg-surface px-5 py-4 text-ink-soft">No website requests waiting.</p> : null}
      <BookingRequests requests={requests} canAct={can(ctx, "manage_appointments") && can(ctx, "manage_patients")} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Panel title="Today" flush>
          {board.appointments.length === 0 ? <p className="px-5 py-4 text-ink-soft">No appointments today.</p> : (
            <ul className="divide-y divide-line">{board.appointments.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-4 px-5 py-3">
                <span className="w-28 tabular-nums">{when(a.start).split(" ").slice(-1)[0]}</span>
                <span className="flex-1 font-medium">{a.patient.full_name} <span className="font-normal text-ink-faint">{a.patient.mrn}</span></span>
                <span className="text-sm text-ink-soft">{STATUS[a.status] ?? a.status}{a.source === "online" ? ", website" : ""}</span>
              </li>))}</ul>
          )}
        </Panel>
        <Panel title="Coming days" flush>
          {upcoming.length === 0 ? <p className="px-5 py-4 text-ink-soft">Nothing booked yet.</p> : (
            <ul className="divide-y divide-line">{upcoming.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-4 px-5 py-3">
                <span className="w-36 tabular-nums">{when(startOf(a.scheduled_range))}</span>
                <span className="flex-1 font-medium">{name(a.patient_id)?.full_name} <span className="font-normal text-ink-faint">{name(a.patient_id)?.mrn}</span></span>
                <span className="text-sm text-ink-soft">{doc(a.doctor_member_id)}{a.source === "online" ? ", website" : ""}</span>
              </li>))}</ul>
          )}
        </Panel>
      </div>
    </>
  );
}
