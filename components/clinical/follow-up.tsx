"use client";

import { useState, useTransition } from "react";
import { bookFollowUp, listMySlots, type MySlot } from "@/app/actions/schedule";
import { Button } from "@/components/ui/primitives";

const hm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Kathmandu", hour: "2-digit", minute: "2-digit" });

/** Book this patient's follow-up in my own diary (U5). The patient gets the usual confirmation. */
export function FollowUpBooker({ patientId, defaultDate }: { patientId: string; defaultDate: string }) {
  const [date, setDate] = useState(defaultDate);
  const [slots, setSlots] = useState<MySlot[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const load = (d: string) => start(async () => { setChosen(""); setMsg(null); setSlots(await listMySlots(d)); });
  const free = (slots ?? []).filter((s) => s.free);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label><span className="block text-xs text-ink-faint">Date</span>
          <input type="date" value={date} onChange={(e) => { setDate(e.target.value); load(e.target.value); }} className="rounded-control border border-line-strong px-2 py-1.5" /></label>
        {slots === null ? <Button type="button" tone="secondary" disabled={pending || !date} onClick={() => load(date)}>Show my times</Button>
          : free.length === 0 ? <span className="text-sm text-ink-soft">No free times that day (or you&apos;re on leave).</span>
          : <label><span className="block text-xs text-ink-faint">Time</span>
              <select value={chosen} onChange={(e) => setChosen(e.target.value)} className="rounded-control border border-line-strong px-2 py-1.5">
                <option value="">Choose</option>{free.map((s) => <option key={s.start} value={s.start}>{hm(s.start)}{s.mode === "token" ? " (token)" : ""}</option>)}</select></label>}
        {slots && free.length ? <Button type="button" disabled={!chosen || pending} onClick={() => start(async () => {
          const r = await bookFollowUp({ patientId, start: chosen });
          setMsg(r.ok ? { ok: true, text: `Follow-up booked for ${new Date(chosen).toLocaleDateString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium" })} at ${hm(chosen)}.` } : { ok: false, text: r.error });
          if (r.ok) setSlots(null);
        })}>{pending ? "Booking…" : "Book follow-up"}</Button> : null}
      </div>
      {msg ? <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-sm text-ok" : "text-sm text-alert"}>{msg.text}</p> : null}
    </div>
  );
}
