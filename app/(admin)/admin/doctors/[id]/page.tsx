import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { getDoctorSchedule, listCatalogue, listDoctors, upcomingSlots } from "@/lib/tenant/setup-data";
import { addException, addSchedule, deleteException, endSchedule, saveDoctor } from "@/app/actions/setup";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Doctor" };
export const dynamic = "force-dynamic";

// Nepal's week starts on Sunday (Aaitabar); Postgres dow 0 = Sunday.
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hm = (t: string | null) => (t ? t.slice(0, 5) : "");
const ktm = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", ...opts }).format(new Date(iso));

function WindowFields({ withRoom = true, optionalTimes = false }: { withRoom?: boolean; optionalTimes?: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      <label className="block"><span className={label}>From</span><input name="start_time" type="time" required={!optionalTimes} defaultValue={optionalTimes ? undefined : "09:00"} className={field} /></label>
      <label className="block"><span className={label}>To</span><input name="end_time" type="time" required={!optionalTimes} defaultValue={optionalTimes ? undefined : "13:00"} className={field} /></label>
      <fieldset className="sm:col-span-2"><legend className={label}>Patients are seen by</legend>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex items-center gap-2 rounded-control border border-line px-2 py-1.5"><input type="radio" name="mode" value="slot" defaultChecked />
            Time slots of <input name="slot_minutes" type="number" min={5} max={240} defaultValue={15} aria-label="Minutes per appointment" className="w-14 rounded border border-line-strong px-1" /> min</label>
          <label className="flex items-center gap-2 rounded-control border border-line px-2 py-1.5"><input type="radio" name="mode" value="token" />
            Tokens, up to <input name="max_tokens" type="number" min={1} max={500} defaultValue={30} aria-label="Tokens per session" className="w-14 rounded border border-line-strong px-1" /></label>
        </div>
      </fieldset>
      {withRoom ? <label className="block"><span className={label}>Room</span><input name="room" className={field} /></label> : null}
    </div>
  );
}

function windowText(w: { start_time: string | null; end_time: string | null; slot_minutes: number | null; max_tokens: number | null }) {
  return `${hm(w.start_time)}–${hm(w.end_time)}, ${w.slot_minutes ? `${w.slot_minutes}-minute slots` : `up to ${w.max_tokens} tokens`}`;
}

export default async function Doctor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_schedules", allowPendingTenant: true, next: `/admin/doctors/${id}` });
  const [doctors, { departments }] = await Promise.all([listDoctors(ctx.tenantId), listCatalogue(ctx.tenantId)]);
  const d = doctors.find((x) => x.member_id === id);
  if (!d) notFound();
  const [{ schedules, exceptions }, slots] = await Promise.all([getDoctorSchedule(ctx.tenantId, id), upcomingSlots(ctx.tenantId, id, 7)]);

  const byDay = new Map<string, typeof slots>();
  for (const sl of slots) {
    const k = ktm(sl.slot_start, { weekday: "short", day: "numeric", month: "short" });
    byDay.set(k, [...(byDay.get(k) ?? []), sl]);
  }

  return (
    <>
      <PageHeader title={d.name} subtitle={<><Link href="/admin/doctors" className="text-pine hover:underline">Doctors</Link> / OPD schedule and profile</>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.5fr_1fr]">
        <div className="space-y-6">
          <Panel title="Weekly OPD" flush>
            <ul className="divide-y divide-line">
              {DAYS.map((day, i) => {
                const ws = schedules.filter((w) => w.weekday === i);
                return (
                  <li key={day} className="flex flex-wrap items-start gap-x-6 gap-y-2 px-5 py-3">
                    <span className="w-24 font-medium">{day}</span>
                    {ws.length === 0 ? <span className="text-ink-faint">No OPD</span> : (
                      <ul className="flex-1 space-y-1.5">
                        {ws.map((w) => (
                          <li key={w.id} className="flex flex-wrap items-center gap-x-3">
                            <span>{windowText(w)}{w.room ? `, ${w.room}` : ""}</span>
                            {w.effective_to ? <span className="text-sm text-warn">until {w.effective_to}</span> : null}
                            {w.effective_from > new Date().toISOString().slice(0, 10) ? <span className="text-sm text-ink-faint">from {w.effective_from}</span> : null}
                            <ActionForm action={endSchedule} submitLabel="Remove" tone="secondary" confirm={`Remove ${day} ${hm(w.start_time)}–${hm(w.end_time)}? Past days keep their record.`} className="[&_button]:px-2 [&_button]:py-0.5 [&_button]:text-xs">
                              <input type="hidden" name="id" value={w.id} /><input type="hidden" name="member_id" value={id} />
                            </ActionForm>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-line p-5">
              <h3 className="mb-3 font-medium">Add OPD hours</h3>
              <ActionForm action={addSchedule} submitLabel="Add OPD hours" resetOnSuccess={false}>
                <input type="hidden" name="member_id" value={id} />
                <fieldset><legend className={label}>On</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">{DAYS.map((day, i) => (
                    <label key={day} className="flex items-center gap-1.5"><input type="checkbox" name="weekday" value={i} />{day.slice(0, 3)}</label>))}</div>
                </fieldset>
                <WindowFields />
                <label className="block max-w-xs"><span className={label}>Starting from</span><input name="effective_from" type="date" className={field} /><span className="mt-1 block text-xs text-ink-faint">Leave empty for today. Existing bookings are never moved.</span></label>
              </ActionForm>
            </div>
          </Panel>

          <Panel title="Leave and one-off changes" flush>
            {exceptions.length === 0 ? <p className="px-5 py-4 text-ink-soft">None coming up.</p> : (
              <ul className="divide-y divide-line">
                {exceptions.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                    <span className="w-28 font-medium tabular-nums">{e.on_date}</span>
                    <span className="flex-1">
                      {e.kind === "leave" ? (e.start_time ? `On leave ${hm(e.start_time)}–${hm(e.end_time)}` : "On leave all day")
                        : `${e.kind === "extra" ? "Extra OPD" : "Changed hours"}: ${windowText(e)}`}
                      {e.reason ? <span className="text-ink-faint">, {e.reason}</span> : null}
                    </span>
                    <ActionForm action={deleteException} submitLabel="Remove" tone="secondary" className="[&_button]:px-2 [&_button]:py-0.5 [&_button]:text-xs">
                      <input type="hidden" name="id" value={e.id} /><input type="hidden" name="member_id" value={id} />
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-line p-5">
              <ActionForm action={addException} submitLabel="Add">
                <input type="hidden" name="member_id" value={id} />
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block"><span className={label}>Date</span><input name="on_date" type="date" required className={field} /></label>
                  <label className="block"><span className={label}>What</span>
                    <select name="kind" className={field}><option value="leave">Leave</option><option value="extra">Extra OPD</option><option value="modified">Different hours that day</option></select></label>
                  <label className="block"><span className={label}>Note</span><input name="reason" placeholder="Optional" className={field} /></label>
                </div>
                <WindowFields withRoom={false} optionalTimes />
                <p className="text-xs text-ink-faint">For a whole day of leave, leave both times empty. Extra OPD and changed hours need times. Booked patients on that day will need a call (booking arrives in B4).</p>
              </ActionForm>
            </div>
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Next 7 days" aside={<span className="text-sm text-ink-faint">Clinic time</span>}>
            {byDay.size === 0 ? <p className="text-ink-soft">No OPD in the next 7 days.</p> : (
              <ul className="space-y-3">
                {[...byDay].map(([day, list]) => (
                  <li key={day}>
                    <div className="font-medium">{day}</div>
                    <div className="text-sm text-ink-soft">
                      {list.filter((x) => x.mode === "slot").length ? `${list.filter((x) => x.mode === "slot").length} slots from ${ktm(list.find((x) => x.mode === "slot")!.slot_start, { hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}
                      {list.filter((x) => x.mode === "token").map((x) => ` · ${x.capacity} tokens ${ktm(x.slot_start, { hour: "2-digit", minute: "2-digit", hour12: false })}–${ktm(x.slot_end, { hour: "2-digit", minute: "2-digit", hour12: false })}`).join("")}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Profile">
            <p className="mb-3 text-sm">
              {!d.credential ? <span className="text-warn">No NMC registration on file. Add it in <Link className="underline" href="/admin/staff">Staff &amp; roles</Link>.</span>
                : d.credential.verified_at ? <span className="text-ok">{d.credential.council} {d.credential.registration_no}, verified</span>
                : <span className="text-warn">{d.credential.council} {d.credential.registration_no}, waiting for verification</span>}
            </p>
            <ActionForm action={saveDoctor} submitLabel="Save profile" resetOnSuccess={false}>
              <input type="hidden" name="member_id" value={id} />
              <label className="block"><span className={label}>Specialty</span><input name="specialty" defaultValue={d.specialty ?? ""} className={field} /></label>
              <label className="block"><span className={label}>Qualifications</span><input name="qualification" defaultValue={d.qualification ?? ""} placeholder="e.g. MBBS, MD" className={field} /></label>
              <label className="block"><span className={label}>Consultation fee (Rs.)</span><input name="consultation_fee" type="number" min={0} step="0.01" defaultValue={d.consultation_fee ?? ""} className={field} /></label>
              <label className="block"><span className={label}>Room</span><input name="room" defaultValue={d.room ?? ""} className={field} /></label>
              <label className="block"><span className={label}>Short bio for the website</span><textarea name="bio" rows={4} maxLength={1500} defaultValue={d.bio ?? ""} className={field} /></label>
              {departments.length ? (
                <fieldset><legend className={label}>Departments</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">{departments.filter((x) => x.is_active || d.departmentIds.includes(x.id)).map((x) => (
                    <label key={x.id} className="flex items-center gap-2"><input type="checkbox" name="department_ids" value={x.id} defaultChecked={d.departmentIds.includes(x.id)} />{x.name}</label>))}</div>
                </fieldset>
              ) : null}
              <label className="flex items-center gap-2"><input type="checkbox" name="is_public" defaultChecked={d.is_public} />Show on the clinic website</label>
            </ActionForm>
          </Panel>
        </div>
      </div>
    </>
  );
}
