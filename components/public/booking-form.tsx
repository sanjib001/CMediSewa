"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { listPublicSlots, requestBooking, type PublicSlot } from "@/app/actions/public-booking";
import { cn } from "@/lib/cn";

const field = "w-full rounded-control border border-line-strong bg-surface px-3 py-2.5 text-ink placeholder:text-ink-faint";
const lbl = "mb-1 block text-sm font-medium";
const hm = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const dayLabel = (d: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${d}T00:00:00Z`));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

type Doctor = { id: string; name: string; specialty: string | null; fee: number | null };

/** The clinic website's booking REQUEST form (D-82): choose doctor and time, leave contact
 *  details; the clinic confirms by phone or email. Nothing is paid online (D-83). */
export function BookingForm({ slug, doctors, today, accent, onAccent }: { slug: string; doctors: Doctor[]; today: string; accent: string; onAccent: string }) {
  const [doctorId, setDoctorId] = useState(doctors.length === 1 ? doctors[0]!.id : "");
  const [date, setDate] = useState(today);
  const [loaded, setLoaded] = useState<{ key: string; slots: PublicSlot[] } | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [pending, run] = useTransition();
  const key = `${doctorId}|${date}`;
  const slots = loaded?.key === key ? loaded.slots : null;
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));

  // A doctor's "Book" button links to #book-<id>: pick that doctor and bring the form into view.
  useEffect(() => {
    const pick = () => {
      const m = /^#book-([0-9a-f-]{36})$/.exec(window.location.hash);
      if (m && doctors.some((d) => d.id === m[1])) {
        setDoctorId(m[1]!); setStart(null);
        document.getElementById("book")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
    pick();
    window.addEventListener("hashchange", pick);
    return () => window.removeEventListener("hashchange", pick);
  }, [doctors]);

  useEffect(() => {
    if (!doctorId) return;
    let live = true;
    const k = `${doctorId}|${date}`;
    listPublicSlots(slug, doctorId, date).then((s) => { if (live) setLoaded({ key: k, slots: s }); });
    return () => { live = false; };
  }, [slug, doctorId, date]);

  if (sent) {
    return (
      <div role="status" className="rounded-panel border border-line bg-surface p-6">
        <p className="text-lg font-semibold">Request sent</p>
        <p className="mt-2 text-ink-soft">The clinic will contact you on the phone number or email you gave to confirm the time. The time is held for you until then.</p>
        <p className="mt-4">Keep this link to see the status or cancel: <Link href={sent} className="font-medium underline">{typeof window === "undefined" ? sent : `${window.location.origin}${sent}`}</Link></p>
      </div>
    );
  }

  return (
    <form className="space-y-6" onSubmit={(e) => {
      e.preventDefault();
      if (!start) { setError("Choose a time."); return; }
      const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
      setError(null);
      run(async () => {
        const r = await requestBooking({ slug, doctorId, start, name: f.name ?? "", phone: f.phone, email: f.email, age: f.age, sex: f.sex, reason: f.reason, consent: f.consent === "on", website: f.website });
        if (r.ok) setSent(r.link);
        else { setError(r.error); setLoaded(null); setStart(null); listPublicSlots(slug, doctorId, date).then((s) => setLoaded({ key, slots: s })); }
      });
    }}>
      <fieldset className="min-w-0">
        <legend className={lbl}>Doctor</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {doctors.map((d) => (
            <label key={d.id} className="flex cursor-pointer items-start gap-3 rounded-control border border-line-strong bg-surface p-3 has-[:checked]:border-2" style={{ borderColor: doctorId === d.id ? accent : undefined }}>
              <input type="radio" name="doctor" value={d.id} checked={doctorId === d.id} onChange={() => { setDoctorId(d.id); setStart(null); }} className="mt-1" />
              <span><span className="block font-medium">{d.name}</span><span className="block text-sm text-ink-soft">{[d.specialty, d.fee !== null ? `Rs. ${d.fee.toLocaleString("en-IN")}` : null].filter(Boolean).join(", ")}</span></span>
            </label>
          ))}
        </div>
      </fieldset>

      {doctorId ? (
        <fieldset className="min-w-0">
          <legend className={lbl}>Day</legend>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {days.map((d) => (
              <button key={d} type="button" onClick={() => { setDate(d); setStart(null); }}
                className={cn("shrink-0 rounded-control border px-3 py-2 text-sm", d === date ? "font-semibold" : "border-line-strong")}
                style={d === date ? { background: accent, color: onAccent, borderColor: accent } : undefined}>
                {d === today ? "Today" : dayLabel(d)}
              </button>
            ))}
          </div>
          <div className="mt-3">
            {slots === null ? <p className="text-ink-faint">Loading times…</p> : slots.length === 0 ? <p className="text-ink-soft">No times available that day. Try another day.</p> : (
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Time">
                {slots.map((s) => (
                  <button key={s.start} type="button" role="radio" aria-checked={start === s.start} onClick={() => setStart(s.start)}
                    className={cn("rounded-control border px-3 py-2 text-sm tabular-nums", start === s.start ? "font-semibold" : "border-line-strong")}
                    style={start === s.start ? { background: accent, color: onAccent, borderColor: accent } : undefined}>
                    {s.mode === "token" ? `${hm(s.start)}–${hm(s.end)} (token, ${s.left} left)` : hm(s.start)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </fieldset>
      ) : null}

      {start ? (
        <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2">
          <legend className="mb-2 font-medium">Patient details</legend>
          <label className="block sm:col-span-2"><span className={lbl}>Patient&apos;s full name</span><input name="name" required maxLength={120} autoComplete="name" className={field} /></label>
          <label className="block"><span className={lbl}>Phone</span><input name="phone" type="tel" autoComplete="tel" placeholder="98XXXXXXXX" className={field} /></label>
          <label className="block"><span className={lbl}>or email (Gmail)</span><input name="email" type="email" autoComplete="email" className={field} /></label>
          <label className="block"><span className={lbl}>Age (years)</span><input name="age" type="number" min={0} max={130} inputMode="numeric" className={field} /></label>
          <label className="block"><span className={lbl}>Sex</span>
            <select name="sex" className={field} defaultValue=""><option value="" disabled>Choose</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></label>
          <label className="block sm:col-span-2"><span className={lbl}>Reason for visit (optional)</span><input name="reason" maxLength={300} className={field} /></label>
          {/* honeypot: hidden from people */}
          <label className="absolute -left-[9999px]" aria-hidden>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
          <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" name="consent" required className="mt-1" />The clinic may call or email me about this request.</label>
        </fieldset>
      ) : null}

      {error ? <p role="alert" className="rounded-control bg-alert-tint px-3 py-2 text-sm text-alert">{error}</p> : null}
      {start ? (
        <button type="submit" disabled={pending} className="w-full rounded-control px-4 py-3 font-semibold disabled:opacity-60 sm:w-auto" style={{ background: accent, color: onAccent }}>
          {pending ? "Sending…" : `Send booking request for ${hm(start)}, ${date === today ? "today" : dayLabel(date)}`}
        </button>
      ) : null}
      <p className="text-sm text-ink-faint">This is a request: the clinic confirms it with you. Nothing is paid online.</p>
    </form>
  );
}
