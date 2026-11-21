import Link from "next/link";
import { requireTenant } from "@/lib/auth/context";
import { serviceClient } from "@/lib/supabase/service";
import { getDoctorSchedule } from "@/lib/tenant/setup-data";
import { todayIn } from "@/lib/desk/data";
import { addMyLeave, removeMyLeave } from "@/app/actions/schedule";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "My schedule" };
export const dynamic = "force-dynamic";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const t5 = (t: string | null) => (t ? t.slice(0, 5) : "");
const day = (iso: string) => new Date(`${iso}T12:00:00+05:45`).toLocaleDateString("en-GB", { timeZone: "Asia/Kathmandu", weekday: "short", day: "numeric", month: "short" });
const hm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Kathmandu", hour: "2-digit", minute: "2-digit" });

// My schedule (U5): my weekly OPD hours (set by the admin), my upcoming appointments, and my
// leave, which I add and remove myself (manage_own_leave). Booked days are passed to the desk.
export default async function MySchedule() {
  const ctx = await requireTenant({ operation: "employee.area", permission: "manage_own_leave", next: "/employee/schedule" });
  const db = serviceClient();
  const { data: profile } = await db.from("doctor_profiles").select("room").eq("tenant_id", ctx.tenantId).eq("member_id", ctx.memberId).maybeSingle();
  if (!profile) {
    return (<><PageHeader title="My schedule" /><p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">You aren&apos;t set up as an OPD doctor at this clinic. An admin adds you in Admin, Doctors &amp; schedules.</p></>);
  }
  const today = todayIn();
  const until = new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
  const [{ schedules, exceptions }, appts] = await Promise.all([
    getDoctorSchedule(ctx.tenantId, ctx.memberId),
    db.from("appointments").select("id, scheduled_range, appointment_date, status, source, patient_id, requester_name").eq("tenant_id", ctx.tenantId).eq("doctor_member_id", ctx.memberId)
      .gte("appointment_date", today).lte("appointment_date", until).in("status", ["requested", "confirmed"]).order("appointment_date").limit(200),
  ]);
  const list = (appts.data ?? []) as { id: string; scheduled_range: string; appointment_date: string; status: string; source: string; patient_id: string | null; requester_name: string | null }[];
  const ids = [...new Set(list.map((a) => a.patient_id).filter(Boolean) as string[])];
  const { data: pts } = ids.length ? await db.from("patients").select("id, full_name").eq("tenant_id", ctx.tenantId).in("id", ids) : { data: [] };
  const name = new Map(((pts ?? []) as { id: string; full_name: string }[]).map((p) => [p.id, p.full_name]));
  const leave = exceptions.filter((e) => e.kind === "leave");
  const onLeave = (d: string, start: string) => leave.some((l) => l.on_date === d && (!l.start_time || (hm(start) < t5(l.end_time) && hm(start) >= t5(l.start_time))));
  const byDay = new Map<string, typeof list>();
  for (const a of list) byDay.set(a.appointment_date, [...(byDay.get(a.appointment_date) ?? []), a]);
  const startOf = (r: string) => /^[[(]"?([^",]+)/.exec(r)?.[1] ?? "";
  return (
    <>
      <PageHeader title="My schedule" subtitle={<><Link href="/employee/opd" className="text-pine hover:underline">OPD</Link> / your hours, bookings for the next two weeks, and your leave.</>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.3fr_1fr]">
        <div className="space-y-6">
          <Panel title="Booked, next 14 days" aside={<span className="text-sm text-ink-faint">{list.length} appointment{list.length === 1 ? "" : "s"}</span>} flush>
            {list.length === 0 ? <p className="px-5 py-4 text-ink-soft">Nothing booked yet.</p> : (
              <ul className="divide-y divide-line">{[...byDay.entries()].map(([d, items]) => (
                <li key={d} className="px-5 py-3">
                  <div className="font-medium">{day(d)}</div>
                  <ul className="mt-1 space-y-0.5 text-sm">{items.map((a) => (
                    <li key={a.id} className="flex justify-between gap-3">
                      <span>{hm(startOf(a.scheduled_range))} {a.patient_id ? name.get(a.patient_id) : a.requester_name}{a.source === "follow_up" ? " (follow-up)" : ""}{a.status === "requested" ? " (request)" : ""}</span>
                      {onLeave(d, startOf(a.scheduled_range)) ? <span className="text-warn">on your leave: the desk will move it</span> : null}
                    </li>))}</ul>
                </li>))}</ul>
            )}
          </Panel>
          <Panel title="Weekly OPD hours" aside={<span className="text-sm text-ink-faint">Set by the admin</span>} flush>
            {schedules.length === 0 ? <p className="px-5 py-4 text-ink-soft">No OPD hours set yet.</p> : (
              <ul className="divide-y divide-line">{schedules.map((s) => (
                <li key={s.id} className="flex justify-between px-5 py-2.5">
                  <span>{DAYS[s.weekday]} {t5(s.start_time)}–{t5(s.end_time)}{s.room ? `, ${s.room}` : profile.room ? `, ${profile.room}` : ""}</span>
                  <span className="text-sm text-ink-soft">{s.slot_minutes ? `${s.slot_minutes}-minute slots` : `${s.max_tokens} tokens`}</span>
                </li>))}</ul>
            )}
          </Panel>
        </div>
        <div className="space-y-6">
          <Panel title="Take leave">
            <ActionForm action={addMyLeave} submitLabel="Add leave">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block"><span className={label}>From</span><input type="date" name="from" required min={today} className={field} /></label>
                <label className="block"><span className={label}>To (same day if blank)</span><input type="date" name="to" min={today} className={field} /></label>
                <label className="block"><span className={label}>Part of a day: from</span><input type="time" name="start_time" className={field} /></label>
                <label className="block"><span className={label}>until</span><input type="time" name="end_time" className={field} /></label>
              </div>
              <label className="block"><span className={label}>Note for yourself and the admin (optional)</span><input name="reason" maxLength={200} className={field} /></label>
              <p className="text-sm text-ink-soft">Those times disappear from booking at once. Appointments already booked are listed for the desk to move; they aren&apos;t cancelled.</p>
            </ActionForm>
          </Panel>
          <Panel title="My leave" flush>
            {leave.length === 0 ? <p className="px-5 py-4 text-ink-soft">No leave coming up.</p> : (
              <ul className="divide-y divide-line">{leave.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <span>{day(l.on_date)}{l.start_time ? ` ${t5(l.start_time)}–${t5(l.end_time)}` : ", all day"}{l.reason ? <span className="block text-sm text-ink-soft">{l.reason}</span> : null}</span>
                  <ActionForm action={removeMyLeave} submitLabel="Remove" tone="secondary" className="[&_button]:px-2 [&_button]:py-0.5 [&_button]:text-xs"><input type="hidden" name="id" value={l.id} /></ActionForm>
                </li>))}</ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
