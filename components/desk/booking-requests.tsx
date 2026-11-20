"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveRequest, declineRequest } from "@/app/actions/desk";
import type { BookingRequest } from "@/lib/desk/data";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const small = "rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm";

/** Website booking requests (D-82): contact the person by phone or Gmail, then approve
 *  (linking an existing patient or registering them) or decline with a message they will see. */
export function BookingRequests({ requests, canAct }: { requests: BookingRequest[]; canAct: boolean }) {
  if (!requests.length) return null;
  return (
    <section aria-label="Website booking requests" className="mb-6 rounded-panel border-2 border-marigold bg-surface">
      <h2 className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3 font-semibold">
        Website booking requests <span className="text-sm font-normal text-ink-faint">{requests.length} waiting. Contact the person, then approve or decline.</span>
      </h2>
      <ul className="divide-y divide-line">{requests.map((r) => <RequestRow key={r.id} r={r} canAct={canAct} />)}</ul>
    </section>
  );
}

function RequestRow({ r, canAct }: { r: BookingRequest; canAct: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "approve" | "decline">("idle");
  const [pick, setPick] = useState<string>(r.matches[0]?.id ?? "new");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const tel = r.phone ? `tel:${r.phone.replace(/[^\d+]/g, "")}` : null;

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-semibold">{r.name}</span>
        <span className="text-sm text-ink-soft">{[r.sex, r.age !== null ? `${r.age}y` : null].filter(Boolean).join(", ")}</span>
        <span className="text-sm">{r.doctorName}, <span className="font-medium">{when(r.start)}</span>{r.mode === "token" ? " (token session)" : ""}</span>
        <span className="ml-auto text-sm text-ink-faint">received {when(r.createdAt)}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {r.phone ? <a href={tel!} className="font-medium text-pine hover:underline">Call {r.phone}</a> : null}
        {r.email ? <a href={`mailto:${r.email}`} className="font-medium text-pine hover:underline">Email {r.email}</a> : null}
        {r.reason ? <span className="text-ink-soft">Reason: {r.reason}</span> : null}
        {r.matches.length ? <span className="text-warn">Phone matches {r.matches.length === 1 ? "an existing patient" : `${r.matches.length} patients`}</span> : null}
      </div>

      {canAct && mode === "idle" ? (
        <div className="mt-3 flex gap-2">
          <Button type="button" className="min-h-9 px-3 text-sm" onClick={() => setMode("approve")}>Approve…</Button>
          <Button type="button" tone="secondary" className="min-h-9 px-3 text-sm" onClick={() => setMode("decline")}>Decline…</Button>
        </div>
      ) : null}

      {mode === "approve" ? (
        <div className="mt-3 space-y-2 rounded-control bg-sunken p-3">
          <p className="text-sm font-medium">Which patient is this?</p>
          {r.matches.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-sm">
              <input type="radio" name={`p-${r.id}`} checked={pick === p.id} onChange={() => setPick(p.id)} />
              {p.full_name}, {p.sex}, {p.age}, MRN {p.mrn}
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`p-${r.id}`} checked={pick === "new"} onChange={() => setPick("new")} />
            New patient: register {r.name}{r.age !== null ? `, ${r.age}y` : ""}{r.sex ? "" : " (choose sex below)"}
          </label>
          {pick === "new" && !r.sex ? (
            <select id={`sex-${r.id}`} className={small} defaultValue=""><option value="" disabled>Sex</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select>
          ) : null}
          {pick === "new" && r.age === null ? <input id={`age-${r.id}`} type="number" min={0} max={130} placeholder="Age (years)" className={cn(small, "w-32")} /> : null}
          <div className="flex gap-2 pt-1">
            <Button type="button" disabled={pending} className="min-h-9 px-3 text-sm" onClick={() => start(async () => {
              const sex = r.sex ?? (document.getElementById(`sex-${r.id}`) as HTMLSelectElement | null)?.value ?? "";
              const age = r.age !== null ? String(r.age) : (document.getElementById(`age-${r.id}`) as HTMLInputElement | null)?.value ?? "";
              const res = await approveRequest(pick === "new"
                ? { appointmentId: r.id, newPatient: { full_name: r.name, sex, age_years: age, phone: r.phone ?? undefined } }
                : { appointmentId: r.id, patientId: pick });
              setMsg(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error });
              if (res.ok) router.refresh();
            })}>{pending ? "Approving…" : "Confirm booking"}</Button>
            <Button type="button" tone="quiet" className="min-h-9 px-3 text-sm" onClick={() => setMode("idle")}>Back</Button>
          </div>
        </div>
      ) : null}

      {mode === "decline" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-control bg-sunken p-3">
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Message the person will see, e.g. Doctor on leave; we offered Sunday" className={cn(small, "min-w-64 flex-1")} />
          <Button type="button" tone="danger" disabled={pending || !reason.trim()} className="min-h-9 px-3 text-sm" onClick={() => start(async () => {
            const res = await declineRequest({ appointmentId: r.id, reason });
            setMsg(res.ok ? { ok: true, text: "Declined." } : { ok: false, text: res.error });
            if (res.ok) router.refresh();
          })}>Decline</Button>
          <Button type="button" tone="quiet" className="min-h-9 px-3 text-sm" onClick={() => setMode("idle")}>Back</Button>
        </div>
      ) : null}
      {msg ? <p role={msg.ok ? "status" : "alert"} className={cn("mt-2 text-sm", msg.ok ? "text-ok" : "text-alert")}>{msg.text}</p> : null}
    </li>
  );
}
