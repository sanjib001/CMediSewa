"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getAdvance, payFromAdvance, refundAdvance, takeAdvance } from "@/app/actions/advances";
import type { AdvanceSummary } from "@/lib/patients/advances";
import { Button } from "@/components/ui/primitives";
import { field } from "@/components/platform/action-form";
import { cn } from "@/lib/cn";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const CHANNELS = [["esewa", "eSewa"], ["khalti", "Khalti"], ["fonepay", "Fonepay"], ["bank_transfer", "Bank transfer"], ["card", "Card"], ["other", "Other"]] as const;
const KIND: Record<string, string> = { deposit: "Taken", refund: "Given back", used: "Paid a bill", returned: "Back from a void" };
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" });
const lbl = "block text-xs text-ink-faint";

/** Cash / online amounts with the online channel, shared by "take" and "give back". */
function MoneyFields({ cash, setCash, online, setOnline, channel, setChannel }: {
  cash: string; setCash: (v: string) => void; online: string; setOnline: (v: string) => void; channel: string; setChannel: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label><span className={lbl}>Cash</span><input type="number" min={0} step="0.01" value={cash} onChange={(e) => setCash(e.target.value)} className={`${field} w-28`} /></label>
      <label><span className={lbl}>Online</span><input type="number" min={0} step="0.01" value={online} onChange={(e) => setOnline(e.target.value)} className={`${field} w-28`} /></label>
      {Number(online) ? <label><span className={lbl}>Paid by</span><select required value={channel} onChange={(e) => setChannel(e.target.value)} className={`${field} w-36`}>
        <option value="">Choose</option>{CHANNELS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label> : null}
    </div>
  );
}

/**
 * A patient's advance (M-52): what is held, taking a deposit, paying open bills from it and
 * giving it back. Loads its own figures so it can sit on any screen that knows the patient.
 */
export function AdvancePanel({ patientId, canTake, canRefund, onChange }: { patientId: string; canTake: boolean; canRefund: boolean; onChange?: (s: AdvanceSummary) => void }) {
  const router = useRouter();
  const [s, setS] = useState<AdvanceSummary | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; print?: string } | null>(null);
  const [pending, start] = useTransition();
  const keys = useRef({ take: crypto.randomUUID(), use: crypto.randomUUID(), refund: crypto.randomUUID() });
  const [cash, setCash] = useState(""); const [online, setOnline] = useState(""); const [channel, setChannel] = useState(""); const [note, setNote] = useState("");
  const [rCash, setRCash] = useState(""); const [rOnline, setROnline] = useState(""); const [rChannel, setRChannel] = useState(""); const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    const r = await getAdvance(patientId);
    if (r.ok) { setS(r.summary); onChange?.(r.summary); } else setMsg({ ok: false, text: r.error });
  }, [patientId, onChange]);
  useEffect(() => {
    let live = true;
    void getAdvance(patientId).then((r) => { if (!live) return; if (r.ok) { setS(r.summary); onChange?.(r.summary); } else setMsg({ ok: false, text: r.error }); });
    return () => { live = false; };
  }, [patientId, onChange]);

  const after = async (text: string, print?: string) => { setMsg({ ok: true, text, print }); await load(); router.refresh(); };

  if (!s) return <p className="text-sm text-ink-soft">Loading the advance…</p>;
  const usable = Math.min(s.balance, s.owed);
  return (
    <div className="space-y-4" aria-label="Advance">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p><span className="text-sm text-ink-soft">Advance held</span> <span className={cn("text-xl font-semibold tabular-nums", s.balance > 0 && "text-pine-deep")}>{npr(s.balance)}</span></p>
        {s.owed > 0 ? <p className="text-sm text-warn">Owes {npr(s.owed)}</p> : null}
      </div>

      {usable > 0 && canTake ? (
        <div className="rounded-control bg-pine-tint px-3 py-2.5">
          <p className="text-sm text-pine-deep">The advance can pay {npr(usable)} of what is owed (oldest bill first).</p>
          <Button type="button" className="mt-2" disabled={pending} onClick={() => start(async () => {
            setMsg(null);
            const r = await payFromAdvance({ idempotencyKey: keys.current.use, patientId });
            if (r.ok) { keys.current.use = crypto.randomUUID(); await after(`${npr(r.used)} paid from the advance. ${npr(r.balance)} left.`); } else setMsg({ ok: false, text: r.error });
          })}>Pay {npr(usable)} from the advance</Button>
        </div>
      ) : null}

      {canTake ? (
        <form className="space-y-2" onSubmit={(e) => {
          e.preventDefault(); setMsg(null);
          start(async () => {
            const r = await takeAdvance({ idempotencyKey: keys.current.take, patientId, cash: Number(cash) || 0, online: Number(online) || 0, channel: channel || null, note: note || null });
            if (r.ok) { keys.current.take = crypto.randomUUID(); setCash(""); setOnline(""); setNote(""); await after(`Receipt ${r.receipt}: ${npr(r.amount)} taken. ${npr(r.balance)} held.`, r.id); }
            else setMsg({ ok: false, text: r.error });
          });
        }}>
          <p className="text-sm font-medium">Take an advance</p>
          <MoneyFields cash={cash} setCash={setCash} online={online} setOnline={setOnline} channel={channel} setChannel={setChannel} />
          <label className="block"><span className={lbl}>For (optional)</span><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Deposit before the operation" className={field} /></label>
          <Button type="submit" disabled={pending || !(Number(cash) || Number(online))}>{pending ? "Saving…" : "Take advance"}</Button>
        </form>
      ) : null}

      {canRefund && s.balance > 0 ? (
        <details>
          <summary className="cursor-pointer text-sm text-pine">Give the advance back</summary>
          <form className="mt-2 space-y-2" onSubmit={(e) => {
            e.preventDefault(); setMsg(null);
            if (!window.confirm(`Give ${npr((Number(rCash) || 0) + (Number(rOnline) || 0))} back to the patient?`)) return;
            start(async () => {
              const r = await refundAdvance({ idempotencyKey: keys.current.refund, patientId, cash: Number(rCash) || 0, online: Number(rOnline) || 0, channel: rChannel || null, note: reason });
              if (r.ok) { keys.current.refund = crypto.randomUUID(); setRCash(""); setROnline(""); setReason(""); await after(`Receipt ${r.receipt}: ${npr(r.amount)} given back. ${npr(r.balance)} held.`, r.id); }
              else setMsg({ ok: false, text: r.error });
            });
          }}>
            <MoneyFields cash={rCash} setCash={setRCash} online={rOnline} setOnline={setROnline} channel={rChannel} setChannel={setRChannel} />
            <label className="block"><span className={lbl}>Reason</span><input required minLength={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Operation cancelled" className={field} /></label>
            <Button type="submit" tone="secondary" disabled={pending}>Give back</Button>
          </form>
        </details>
      ) : null}

      {msg ? (
        <p role={msg.ok ? "status" : "alert"} className={cn("text-sm", msg.ok ? "text-ok" : "text-alert")}>
          {msg.text} {msg.print ? <Link href={`/employee/advance-receipt/${msg.print}`} className="text-pine underline">Print receipt</Link> : null}
        </p>
      ) : null}

      {s.moves.length ? (
        <ul className="divide-y divide-line border-t border-line text-sm">
          {s.moves.map((m) => (
            <li key={`${m.kind}-${m.id}`} className="flex justify-between gap-3 py-2">
              <span>{KIND[m.kind]} · {m.printable ? <Link href={`/employee/advance-receipt/${m.id}`} className="text-pine hover:underline">{m.no}</Link> : m.no}
                <span className="block text-xs text-ink-faint">{when(m.at)}{m.note ? `, ${m.note}` : ""}</span></span>
              <span className={cn("tabular-nums", m.amount < 0 && "text-ink-soft")}>{m.amount > 0 ? "+" : "−"} {npr(Math.abs(m.amount))}</span>
            </li>))}
        </ul>
      ) : null}
    </div>
  );
}
