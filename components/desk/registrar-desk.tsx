"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { bookAppointment, checkIn, listSlots, moveVisit, registerPatient, rescheduleAppointment, searchPatients, setAppointmentStatus, type Slot } from "@/app/actions/desk";
import Link from "next/link";
import type { DeskDoctor, DeskService, DeskSettings, PatientLite, QueueVisit, TodayAppointment } from "@/lib/desk/data";
import { Button } from "@/components/ui/primitives";
import { OpdTicket } from "@/components/ui/opd-ticket";
import { cn } from "@/lib/cn";

const field = "w-full rounded-control border border-line-strong bg-surface px-3 py-2.5 text-ink placeholder:text-ink-faint";
const lbl = "mb-1 block text-sm font-medium";
const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const hm = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const newKey = () => crypto.randomUUID();

const VISIT_CHIP: Record<string, [string, string]> = {
  waiting: ["Waiting", "bg-warn-tint text-warn"], with_doctor: ["With doctor", "bg-pine-tint text-pine-deep"],
  awaiting_billing: ["To bill", "bg-marigold-tint text-marigold-ink"], closed: ["Done", "bg-ok-tint text-ok"], cancelled: ["Cancelled", "bg-sunken text-ink-faint"],
};
const APPT_CHIP: Record<string, [string, string]> = {
  requested: ["Requested", "bg-sunken text-ink-soft"], confirmed: ["Booked", "bg-sunken text-ink-soft"], checked_in: ["Arrived", "bg-warn-tint text-warn"],
  in_consultation: ["With doctor", "bg-pine-tint text-pine-deep"], completed: ["Done", "bg-ok-tint text-ok"], cancelled: ["Cancelled", "bg-sunken text-ink-faint"], no_show: ["No-show", "bg-alert-tint text-alert"],
};
function Chip({ map, s }: { map: Record<string, [string, string]>; s: string }) {
  const [label, cls] = map[s] ?? [s, "bg-sunken"];
  return <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-sm font-medium", cls)}>{label}</span>;
}
function Alert({ text }: { text: string | null }) {
  return text ? <p role="alert" className="rounded-control bg-alert-tint px-3 py-2 text-sm text-alert">{text}</p> : null;
}

export function RegistrarDesk(props: {
  today: string; doctors: DeskDoctor[]; services: DeskService[]; settings: DeskSettings;
  visits: QueueVisit[]; appointments: TodayAppointment[]; now: number;
  can: { register: boolean; book: boolean; checkIn: boolean; cancel: boolean };
  rxByVisit?: Record<string, { id: string; no: string }>; initialQuery?: string;
}) {
  const router = useRouter();
  const [patient, setPatient] = useState<PatientLite | null>(null);
  const [appointmentId, setAppointmentId] = useState<string | null>(null);
  const [doctorId, setDoctorId] = useState(props.doctors[0]?.id ?? "");
  const [tab, setTab] = useState<"checkin" | "book">("checkin");

  const pick = (p: PatientLite, appt?: TodayAppointment) => {
    setPatient(p);
    if (appt) { setDoctorId(appt.doctorId); setAppointmentId(appt.id); setTab("checkin"); }
    else {
      const a = props.appointments.find((x) => x.patient.id === p.id && x.status === "confirmed");
      setAppointmentId(a?.id ?? null);
      if (a) setDoctorId(a.doctorId);
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,27rem)_1fr]">
      <div className="space-y-5">
        <section aria-label="Patient" className="rounded-panel border border-line bg-surface p-5">
          {patient ? (
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-lg font-semibold">{patient.full_name}</p>
                <p className="text-sm text-ink-soft">MRN {patient.mrn}, {patient.sex}, {patient.age}{patient.phone ? `, ${patient.phone}` : ""}</p>
                {patient.possible_duplicate ? <p className="mt-1 text-sm text-warn">May already be registered under another MRN. Check before billing.</p> : null}
              </div>
              <button type="button" className="text-sm text-pine hover:underline" onClick={() => { setPatient(null); setAppointmentId(null); }}>Change</button>
            </div>
          ) : <PatientFinder canRegister={props.can.register} onPick={pick} initialQuery={props.initialQuery} />}
        </section>

        {patient ? (
          <section className="rounded-panel border border-line bg-surface">
            <div role="tablist" className="flex border-b border-line">
              {(["checkin", "book"] as const).filter((t) => (t === "checkin" ? props.can.checkIn : props.can.book)).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)}
                  className={cn("flex-1 px-4 py-3 font-medium", tab === t ? "border-b-2 border-pine text-pine-deep" : "text-ink-soft")}>
                  {t === "checkin" ? "Check in now" : "Book for later"}
                </button>
              ))}
            </div>
            <div className="p-5">
              {tab === "checkin" && props.can.checkIn ? (
                <CheckInForm key={`${patient.id}-${appointmentId}`} patient={patient} doctors={props.doctors} services={props.services} settings={props.settings}
                  doctorId={doctorId} setDoctorId={(d) => { setDoctorId(d); setAppointmentId(props.appointments.find((x) => x.patient.id === patient.id && x.doctorId === d && x.status === "confirmed")?.id ?? null); }}
                  appointment={props.appointments.find((a) => a.id === appointmentId) ?? null}
                  onDone={() => { setPatient(null); setAppointmentId(null); router.refresh(); }} />
              ) : null}
              {tab === "book" && props.can.book ? (
                <BookForm key={patient.id} patient={patient} doctors={props.doctors} services={props.services} today={props.today} onDone={() => router.refresh()} />
              ) : null}
            </div>
          </section>
        ) : null}
      </div>

      <TodayBoard {...props} rxByVisit={props.rxByVisit} onCheckIn={(a) => pick(a.patient, a)} />
    </div>
  );
}

// ── find or register ─────────────────────────────────────────────────────────
function PatientFinder({ canRegister, onPick, initialQuery }: { canRegister: boolean; onPick: (p: PatientLite) => void; initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery ?? "");
  const [results, setResults] = useState<PatientLite[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 1 || adding) return;
    const n = ++seq.current;
    const t = setTimeout(() => start(async () => {
      try { const r = await searchPatients(term); if (n === seq.current) setResults(r); }
      catch { if (n === seq.current) setError("Search failed. Try again."); }
    }), 250);
    return () => clearTimeout(t);
  }, [q, adding]);

  if (adding) return <NewPatientForm initialName={/\d/.test(q) ? "" : q} initialPhone={/^[\d +()-]{7,}$/.test(q.trim()) ? q.trim() : ""} onCancel={() => setAdding(false)} onCreated={onPick} />;
  return (
    <div>
      <label className="block">
        <span className={lbl}>Find the patient</span>
        <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setError(null); }} className={field} placeholder="Name, phone or MRN" />
      </label>
      <Alert text={error} />
      {results && q.trim() ? (
        <ul className="mt-2 max-h-80 divide-y divide-line overflow-auto rounded-control border border-line" aria-busy={pending}>
          {results.length === 0 ? <li className="px-3 py-2.5 text-ink-soft">No match.</li> : results.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onPick(p)} className="flex w-full items-baseline gap-3 px-3 py-2.5 text-left hover:bg-sunken">
                <span className="font-medium">{p.full_name}</span>
                <span className="text-sm text-ink-faint">{p.sex.charAt(0).toUpperCase()}, {p.age}</span>
                <span className="ml-auto text-sm tabular-nums text-ink-soft">{p.phone ?? ""} · {p.mrn}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {canRegister ? (
        <button type="button" onClick={() => setAdding(true)} className="mt-3 text-sm font-medium text-pine hover:underline">
          {q.trim() ? `Not found? Register a new patient` : "Register a new patient"}
        </button>
      ) : null}
    </div>
  );
}

function NewPatientForm({ initialName, initialPhone, onCancel, onCreated }: { initialName: string; initialPhone: string; onCancel: () => void; onCreated: (p: PatientLite) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
      setError(null);
      start(async () => {
        const r = await registerPatient({ full_name: f.full_name ?? "", sex: f.sex ?? "", age_years: f.age_years, date_of_birth: f.date_of_birth, phone: f.phone, address: f.address, guardian_name: f.guardian_name });
        if (r.ok) onCreated(r.patient); else setError(r.error);
      });
    }}>
      <p className="font-semibold">New patient</p>
      <label className="block"><span className={lbl}>Full name</span><input name="full_name" defaultValue={initialName} required autoFocus className={field} /></label>
      <fieldset><legend className={lbl}>Sex</legend>
        <div className="grid grid-cols-3 gap-2">{[["female", "Female"], ["male", "Male"], ["other", "Other"]].map(([v, l]) => (
          <label key={v} className="flex cursor-pointer items-center justify-center rounded-control border border-line-strong px-2 py-2 text-sm has-[:checked]:border-pine has-[:checked]:bg-pine-tint has-[:checked]:font-medium">
            <input type="radio" name="sex" value={v} required className="sr-only" />{l}</label>))}</div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className={lbl}>Age (years)</span><input name="age_years" type="number" min={0} max={130} inputMode="numeric" className={field} /></label>
        <label className="block"><span className={lbl}>or date of birth</span><input name="date_of_birth" type="date" className={field} /></label>
      </div>
      <label className="block"><span className={lbl}>Phone</span><input name="phone" type="tel" defaultValue={initialPhone} className={field} /></label>
      <label className="block"><span className={lbl}>Address</span><input name="address" placeholder="e.g. Lalitpur-5, Pulchowk" className={field} /></label>
      <label className="block"><span className={lbl}>Guardian (for a child)</span><input name="guardian_name" className={field} /></label>
      <Alert text={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Register"}</Button>
        <Button type="button" tone="secondary" onClick={onCancel}>Back to search</Button>
      </div>
    </form>
  );
}

// ── check in with the OPD fee ────────────────────────────────────────────────
function CheckInForm({ patient, doctors, services, settings, doctorId, setDoctorId, appointment, onDone }: {
  patient: PatientLite; doctors: DeskDoctor[]; services: DeskService[]; settings: DeskSettings;
  doctorId: string; setDoctorId: (d: string) => void; appointment: TodayAppointment | null; onDone: () => void;
}) {
  const billing = settings.billingPoint === "check_in";
  const consults = services.filter((s) => s.kind === "consultation");
  const [serviceId, setServiceId] = useState(consults[0]?.id ?? services[0]?.id ?? "");
  const [discount, setDiscount] = useState(0);
  const [method, setMethod] = useState<"cash" | "online" | "mixed">("cash");
  const [cash, setCash] = useState<number | null>(null);
  const [channel, setChannel] = useState("esewa");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Extract<Awaited<ReturnType<typeof checkIn>>, { ok: true }> | null>(null);
  const [pending, start] = useTransition();
  const key = useRef(newKey());

  const doctor = doctors.find((d) => d.id === doctorId);
  const service = services.find((s) => s.id === serviceId);
  const price = service ? (service.kind === "consultation" && doctor?.fee != null ? doctor.fee : service.price) : 0;
  const net = Math.max(0, price - discount);
  const tax = service?.taxCategory === "vat13" ? Math.round(net * 13) / 100 : 0;
  const total = net + tax;
  const cashPart = method === "cash" ? total : method === "online" ? 0 : Math.min(total, cash ?? 0);
  const onlinePart = method === "cash" ? 0 : total - cashPart;
  const discountPct = price > 0 ? (discount * 100) / price : 0;

  if (result) {
    return (
      <div className="space-y-4 text-center">
        <OpdTicket token={result.token} doctor={doctor?.name ?? ""} room={doctor?.room ?? undefined} size="lg" />
        <p className="text-ink-soft">
          {patient.full_name}{result.invoiceNo ? <>, bill {result.invoiceNo}{result.receiptNo ? `, receipt ${result.receiptNo}` : ""}: paid {npr(result.paid)}{result.due > 0 ? `, due ${npr(result.due)}` : ""}</> : null}
          {result.replayed ? " (already recorded)" : ""}
        </p>
        <div className="flex justify-center gap-2">
          <Link href={`/employee/registrar/receipt/${result.visitId}`} className="rounded-control border border-line-strong px-4 py-2 font-medium">Print token{result.invoiceNo ? " and receipt" : ""}</Link>
          <Button type="button" onClick={onDone}>Next patient</Button>
        </div>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => {
      e.preventDefault();
      setError(null);
      start(async () => {
        const r = await checkIn({
          idempotencyKey: key.current, patientId: patient.id, doctorId, appointmentId: appointment?.id ?? null,
          serviceId: billing ? serviceId : serviceId || null, discount: billing ? discount : 0,
          cash: billing ? cashPart : 0, online: billing ? onlinePart : 0, channel: billing && onlinePart > 0 ? channel : null, reference: reference || null,
        });
        if (r.ok) setResult(r); else { setError(r.error); }
      });
    }}>
      {appointment ? <p className="rounded-control bg-pine-tint px-3 py-2 text-sm text-pine-deep">Has a {hm(appointment.start)} appointment. It will be marked arrived.</p> : null}
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className={lbl}>Doctor</span>
          <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className={field}>{doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label className="block"><span className={lbl}>Service</span>
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className={field}>{services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      </div>

      {billing ? (
        <>
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 rounded-control bg-sunken px-3 py-2.5 text-[0.95rem]">
            <dt>Fee</dt><dd className="text-right tabular-nums">{npr(price)}</dd>
            {discount > 0 ? <><dt>Discount</dt><dd className="text-right tabular-nums">− {npr(discount)}</dd></> : null}
            {tax > 0 ? <><dt>VAT 13%</dt><dd className="text-right tabular-nums">{npr(tax)}</dd></> : null}
            <dt className="font-semibold">To pay</dt><dd className="text-right font-semibold tabular-nums">{npr(total)}</dd>
          </dl>
          <details>
            <summary className="cursor-pointer text-sm text-pine">Discount</summary>
            <label className="mt-2 block"><span className={lbl}>Discount (Rs.), up to {settings.maxDiscountPct}% at the desk</span>
              <input type="number" min={0} max={price} step="1" value={discount || ""} onChange={(e) => setDiscount(Math.max(0, Number(e.target.value) || 0))} className={field} /></label>
            {discountPct > settings.maxDiscountPct ? <p className="mt-1 text-sm text-warn">Above the desk limit: an admin must approve it.</p> : null}
          </details>
          {total > 0 ? (
            <fieldset>
              <legend className={lbl}>Payment</legend>
              <div className="grid grid-cols-3 gap-2">
                {([["cash", "Cash"], ["online", "Online"], ["mixed", "Cash + online"]] as const).map(([v, l]) => (
                  <label key={v} className="flex cursor-pointer items-center justify-center rounded-control border border-line-strong px-2 py-2.5 text-sm has-[:checked]:border-pine has-[:checked]:bg-pine-tint has-[:checked]:font-medium has-[:checked]:text-pine-deep">
                    <input type="radio" name="method" className="sr-only" checked={method === v} onChange={() => setMethod(v)} />{l}</label>))}
              </div>
              {method === "mixed" ? (
                <label className="mt-3 block"><span className={lbl}>Cash part (Rs.)</span>
                  <input type="number" min={0} max={total} value={cash ?? ""} onChange={(e) => setCash(Number(e.target.value) || 0)} className={field} /></label>
              ) : null}
              {method !== "cash" ? (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <label className="block"><span className={lbl}>Online {npr(onlinePart)} via</span>
                    <select value={channel} onChange={(e) => setChannel(e.target.value)} className={field}>
                      {[["esewa", "eSewa"], ["khalti", "Khalti"], ["fonepay", "Fonepay QR"], ["bank_transfer", "Bank transfer"], ["card", "Card"], ["other", "Other"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select></label>
                  <label className="block"><span className={lbl}>Reference</span><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Transaction ID" className={field} /></label>
                </div>
              ) : null}
            </fieldset>
          ) : null}
        </>
      ) : <p className="text-sm text-ink-soft">This clinic bills {settings.billingPoint === "checkout" ? "after the consultation" : "outside the system"}, so no fee is taken now.</p>}

      <Alert text={error} />
      <Button type="submit" className="w-full" disabled={pending || !doctorId}>
        {pending ? "Working…" : billing && total > 0 ? `Check in and take ${npr(total)}` : "Check in and give token"}
      </Button>
    </form>
  );
}

// ── book for later ───────────────────────────────────────────────────────────
function BookForm({ patient, doctors, services, today, onDone }: { patient: PatientLite; doctors: DeskDoctor[]; services: DeskService[]; today: string; onDone: () => void }) {
  const [doctorId, setDoctorId] = useState(doctors[0]?.id ?? "");
  const [date, setDate] = useState(today);
  const [loaded, setLoaded] = useState<{ key: string; slots: Slot[] } | null>(null);
  const slotKey = `${doctorId}|${date}`;
  const slots = loaded?.key === slotKey ? loaded.slots : null;
  const setSlots = (list: Slot[]) => setLoaded({ key: slotKey, slots: list });
  const [chosen, setChosen] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    if (!doctorId || !date) return;
    let live = true;
    const key = `${doctorId}|${date}`;
    listSlots(doctorId, date).then((s) => { if (live) setLoaded({ key, slots: s }); }, () => { if (live) setLoaded({ key, slots: [] }); });
    return () => { live = false; };
  }, [doctorId, date]);
  const free = useMemo(() => (slots ?? []).filter((s) => s.booked < s.capacity), [slots]);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className={lbl}>Doctor</span>
          <select value={doctorId} onChange={(e) => { setDoctorId(e.target.value); setChosen(null); }} className={field}>{doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label className="block"><span className={lbl}>Date</span><input type="date" min={today} value={date} onChange={(e) => { setDate(e.target.value); setChosen(null); }} className={field} /></label>
      </div>
      {slots === null ? <p className="text-ink-faint">Loading times…</p> : slots.length === 0 ? <p className="text-ink-soft">No OPD that day.</p> : (
        <div className="flex flex-wrap gap-2">
          {slots.map((s) => {
            const full = s.booked >= s.capacity;
            return (
              <button key={s.start} type="button" disabled={full} onClick={() => setChosen(s.start)}
                className={cn("rounded-control border px-3 py-1.5 text-sm tabular-nums", chosen === s.start ? "border-pine bg-pine-tint font-medium text-pine-deep" : "border-line-strong", full && "opacity-40 line-through")}>
                {hm(s.start)}{s.mode === "token" ? `–${hm(s.end)} token (${s.capacity - s.booked} left)` : ""}
              </button>
            );
          })}
        </div>
      )}
      {slots && slots.length > 0 && free.length === 0 ? <p className="text-sm text-warn">Fully booked.</p> : null}
      <label className="block"><span className={lbl}>Reason for visit</span><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className={field} placeholder="Optional" /></label>
      {msg ? <p role={msg.ok ? "status" : "alert"} className={cn("rounded-control px-3 py-2 text-sm", msg.ok ? "bg-ok-tint text-ok" : "bg-alert-tint text-alert")}>{msg.text}</p> : null}
      <Button type="button" disabled={!chosen || pending} className="w-full" onClick={() => start(async () => {
        const r = await bookAppointment({ patientId: patient.id, doctorId, start: chosen!, serviceId: services.find((s) => s.kind === "consultation")?.id, reason, source: "phone" });
        setMsg(r.ok ? { ok: true, text: `Booked ${patient.full_name} at ${hm(chosen!)} on ${date}.` } : { ok: false, text: r.error });
        if (r.ok) { setChosen(null); onDone(); listSlots(doctorId, date).then(setSlots); }
      })}>{pending ? "Booking…" : chosen ? `Book ${hm(chosen)}` : "Choose a time"}</Button>
    </div>
  );
}

// ── today's board ────────────────────────────────────────────────────────────
function TodayBoard({ doctors, visits, appointments, can, onCheckIn, now: serverNow, rxByVisit = {} }: {
  doctors: DeskDoctor[]; visits: QueueVisit[]; appointments: TodayAppointment[]; can: { cancel: boolean; book: boolean; checkIn: boolean };
  onCheckIn: (a: TodayAppointment) => void; now: number; rxByVisit?: Record<string, { id: string; no: string }>;
}) {
  const [moving, setMoving] = useState<string | null>(null);
  const [now, setNow] = useState(serverNow);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ kind: "visit" | "appt"; id: string } | null>(null);
  const [reason, setReason] = useState("");
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) => start(async () => {
    setError(null);
    const r = await fn();
    if (!r.ok) setError(r.error ?? "Failed."); else { setAsking(null); setReason(""); router.refresh(); }
  });
  const waitMin = (iso: string) => Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  const upcoming = appointments.filter((a) => ["requested", "confirmed"].includes(a.status));

  const ReasonBox = ({ onConfirm }: { onConfirm: () => void }) => (
    <span className="flex flex-wrap items-center gap-2">
      <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" className="rounded-control border border-line-strong px-2 py-1 text-sm" />
      <button type="button" disabled={busy || !reason.trim()} onClick={onConfirm} className="text-sm font-medium text-alert disabled:opacity-40">Confirm</button>
      <button type="button" onClick={() => setAsking(null)} className="text-sm text-ink-soft">Keep</button>
    </span>
  );

  return (
    <div className="space-y-6">
      <Alert text={error} />
      {upcoming.length ? (
        <section className="rounded-panel border border-line bg-surface">
          <h2 className="border-b border-line px-5 py-3 font-semibold">Appointments today</h2>
          <ul className="divide-y divide-line">
            {upcoming.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                <span className="w-14 font-medium tabular-nums">{hm(a.start)}</span>
                <span className="min-w-0 flex-1"><span className="font-medium">{a.patient.full_name}</span> <span className="text-sm text-ink-faint">{a.patient.age}, {doctors.find((d) => d.id === a.doctorId)?.name}{a.mode === "token" ? ", token session" : ""}</span></span>
                <Chip map={APPT_CHIP} s={a.status} />
                {moving === a.id ? <Reschedule appointment={a} doctors={doctors} onClose={() => setMoving(null)} onDone={() => { setMoving(null); router.refresh(); }} /> : asking?.id === a.id ? <ReasonBox onConfirm={() => act(() => setAppointmentStatus({ appointmentId: a.id, status: "cancelled", reason }))} /> : (
                  <span className="flex gap-3 text-sm">
                    {can.checkIn && a.status === "confirmed" ? <button type="button" className="font-medium text-pine hover:underline" onClick={() => onCheckIn(a)}>Check in</button> : null}
                    {can.book && a.status === "confirmed" ? <button type="button" className="text-ink-soft hover:underline" onClick={() => setMoving(a.id)}>Reschedule</button> : null}
                    {can.book ? <button type="button" className="text-ink-soft hover:underline" onClick={() => { setAsking({ kind: "appt", id: a.id }); setReason(""); }}>Cancel</button> : null}
                    {can.book && Date.parse(a.start) < now ? <button type="button" className="text-ink-soft hover:underline" disabled={busy} onClick={() => act(() => setAppointmentStatus({ appointmentId: a.id, status: "no_show" }))}>No-show</button> : null}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {doctors.map((d) => {
        const q = visits.filter((v) => v.doctorId === d.id);
        const waiting = q.filter((v) => v.status === "waiting").length;
        return (
          <section key={d.id} className="rounded-panel border border-line bg-surface">
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
              <h2 className="font-semibold">{d.name}</h2>
              <span className="text-sm text-ink-faint">{[d.room, `${waiting} waiting`].filter(Boolean).join(", ")}</span>
            </div>
            {q.length === 0 ? <p className="px-5 py-4 text-ink-soft">No patients yet today.</p> : (
              <table className="w-full text-left text-[0.95rem]">
                <thead className="text-sm text-ink-faint"><tr>
                  <th className="px-5 py-2 font-medium">Token</th><th className="py-2 font-medium">Patient</th>
                  <th className="hidden py-2 font-medium sm:table-cell">Bill</th><th className="px-5 py-2 text-right font-medium">Status</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {q.map((v) => (
                    <tr key={v.id} className={v.status === "cancelled" ? "text-ink-faint" : ""}>
                      <td className="px-5 py-2.5"><span className="inline-block min-w-9 rounded bg-marigold-tint px-2 text-center font-bold text-marigold-ink">{v.token}</span></td>
                      <td className="py-2.5">
                        <span className="font-medium">{v.patient.full_name}</span> <span className="text-sm text-ink-faint">{v.patient.age}</span>
                        {v.status === "waiting" ? <span className="block text-sm text-ink-faint">waiting {waitMin(v.checkedInAt)} min</span> : null}
                      </td>
                      <td className="hidden py-2.5 text-sm text-ink-soft sm:table-cell">
                        {v.invoiceNo ? `${v.invoiceNo}: ${npr(v.paid ?? 0)}${(v.total ?? 0) > (v.paid ?? 0) ? `, due ${npr((v.total ?? 0) - (v.paid ?? 0))}` : ""}` : "—"}
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        {asking?.id === v.id ? <ReasonBox onConfirm={() => act(() => moveVisit({ visitId: v.id, to: "cancelled", reason }))} /> : (
                          <span className="inline-flex items-center gap-3">
                            <Chip map={VISIT_CHIP} s={v.status} />
                            {v.status !== "cancelled" ? <Link href={`/employee/registrar/receipt/${v.id}`} className="text-sm text-pine hover:underline">Receipt</Link> : null}
                            {rxByVisit[v.id] ? <Link href={`/employee/registrar/rx/${rxByVisit[v.id]!.id}`} className="text-sm text-pine hover:underline">Print Rx</Link> : null}
                            {can.cancel && v.status === "waiting" ? <button type="button" className="text-sm text-ink-soft hover:underline" onClick={() => { setAsking({ kind: "visit", id: v.id }); setReason(""); }}>Cancel</button> : null}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ── reschedule ────────────────────────────────────────────────────────────────
function Reschedule({ appointment, doctors, onClose, onDone }: { appointment: TodayAppointment; doctors: DeskDoctor[]; onClose: () => void; onDone: () => void }) {
  const [doctorId, setDoctorId] = useState(appointment.doctorId);
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(new Date(appointment.start)));
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const load = (d: string, doc: string) => start(async () => { setChosen(null); setError(null); setSlots(await listSlots(doc, d)); });
  return (
    <span className="flex w-full flex-wrap items-center gap-2 text-sm">
      <select value={doctorId} onChange={(e) => { setDoctorId(e.target.value); load(date, e.target.value); }} className="rounded-control border border-line-strong px-2 py-1" aria-label="Doctor">
        {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      <input type="date" value={date} onChange={(e) => { setDate(e.target.value); load(e.target.value, doctorId); }} className="rounded-control border border-line-strong px-2 py-1" aria-label="New date" />
      {slots === null ? <button type="button" className="text-pine hover:underline" onClick={() => load(date, doctorId)}>Show times</button>
        : slots.length === 0 ? <span className="text-ink-soft">No free times that day.</span>
        : <select value={chosen ?? ""} onChange={(e) => setChosen(e.target.value || null)} className="rounded-control border border-line-strong px-2 py-1" aria-label="New time">
            <option value="">Choose a time</option>{slots.filter((s) => s.mode === "token" ? s.booked < s.capacity : s.booked === 0).map((s) => <option key={s.start} value={s.start}>{hm(s.start)}{s.mode === "token" ? " (token)" : ""}</option>)}</select>}
      <button type="button" disabled={!chosen || pending} className="font-medium text-pine disabled:opacity-40" onClick={() => start(async () => {
        const r = await rescheduleAppointment({ appointmentId: appointment.id, start: chosen!, doctorId: doctorId !== appointment.doctorId ? doctorId : null });
        if (r.ok) onDone(); else setError(r.error);
      })}>{pending ? "Moving…" : "Move"}</button>
      <button type="button" onClick={onClose} className="text-ink-soft">Keep</button>
      {error ? <span role="alert" className="w-full text-alert">{error}</span> : null}
    </span>
  );
}
