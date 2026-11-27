"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { findPatient, issueSale } from "@/app/actions/pharmacy";
import type { PatientLite } from "@/lib/desk/data";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { normalizePhone, phoneProblem } from "@/lib/phone";

// Other sales (D-158): where the pharmacy is also the clinic's billing counter, bill typed-in
// items (lab tests, dressings, ...) under a title such as "Lab". No stock, no catalogue, no VAT;
// the money is booked as other income. The database re-checks the "other_sales" permission.

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const field = "w-full rounded-control border border-line-strong bg-surface px-3 py-2.5 text-base";
const CHANNELS = [["esewa", "eSewa"], ["khalti", "Khalti"], ["fonepay", "Fonepay"], ["bank_transfer", "Bank transfer"], ["card", "Card"], ["other", "Other"]] as const;
const TITLES = ["Lab", "X-ray", "Ultrasound", "ECG", "Dressing", "Injection", "Procedure", "Other"];
const round2 = (n: number) => Math.round(n * 100) / 100;

type Line = { key: string; description: string; qty: string; rate: string };
const blank = (): Line => ({ key: crypto.randomUUID(), description: "", qty: "1", rate: "" });
type Done = { id: string; no: string; total: number; due: number; fromAdvance: number };

export function OtherSale({ storeId, allowCredit }: { storeId: string; allowCredit: boolean }) {
  const key = useRef(crypto.randomUUID());
  const [title, setTitle] = useState("");
  const [lines, setLines] = useState<Line[]>(() => [blank()]);
  const [patient, setPatient] = useState<PatientLite | null>(null);
  const [pq, setPq] = useState(""); const [pres, setPres] = useState<PatientLite[]>([]);
  const [name, setName] = useState(""); const [phone, setPhone] = useState("");
  const [cash, setCash] = useState(""); const [online, setOnline] = useState(""); const [channel, setChannel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [pending, start] = useTransition();

  const amount = (l: Line) => round2((Number(l.qty) || 0) * round2(Number(l.rate) || 0));
  const total = round2(lines.reduce((s, l) => s + amount(l), 0));
  const paid = round2((Number(cash) || 0) + (Number(online) || 0));
  const due = round2(total - paid);
  const filled = lines.filter((l) => l.description.trim() || l.rate.trim());
  const set = (k: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const add = () => { const l = blank(); setLines((ls) => [...ls, l]); setTimeout(() => document.querySelector<HTMLInputElement>(`[data-desc-for="${l.key}"]`)?.focus(), 0); };
  const searchPatient = (v: string) => { setPq(v); if (v.trim().length >= 2) start(async () => setPres(await findPatient(v))); else setPres([]); };
  const phoneIssue = patient ? null : phoneProblem(normalizePhone(phone));

  function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    if (!filled.length) { setErr("Add at least one line: what it is for, the quantity and the rate."); return; }
    const bad = filled.findIndex((l) => !l.description.trim() || !(Number(l.qty) > 0) || l.rate.trim() === "" || !(Number(l.rate) >= 0));
    if (bad >= 0) { setErr(`Line ${bad + 1}: enter what it is for, a quantity above 0 and a rate.`); return; }
    if (phoneIssue) { setErr(`Customer phone: ${phoneIssue}`); return; }
    if (paid > total) { setErr("More was paid than the bill total."); return; }
    if (due > 0 && !patient) { setErr("Take the full payment, or link a patient to leave part of it due."); return; }
    if (due > 0 && !allowCredit) { setErr("Take the full payment. Dues aren't allowed for this sale."); return; }
    if ((Number(online) || 0) > 0 && !channel) { setErr("Choose how the online amount was paid."); return; }
    start(async () => {
      const res = await issueSale({
        idempotencyKey: key.current, storeId, patientId: patient?.id ?? null, customerName: patient ? "" : name, customerPhone: patient ? "" : phone,
        title: title.trim() || null,
        lines: filled.map((l) => ({ kind: "other", description: l.description.trim(), qty: Number(l.qty), unit_price: round2(Number(l.rate)) })),
        cash: Number(cash) || 0, online: Number(online) || 0, channel: channel || null,
      });
      if (res.ok) setDone(res); else setErr(res.error);
    });
  }
  function fresh() {
    key.current = crypto.randomUUID(); setTitle(""); setLines([blank()]); setPatient(null); setPq(""); setPres([]);
    setName(""); setPhone(""); setCash(""); setOnline(""); setChannel(""); setErr(null); setDone(null);
  }

  if (done) return (
    <div className="rounded-panel border border-ok/40 bg-ok/5 p-5" role="status">
      <p className="text-lg font-medium">Bill {done.no} issued: {npr(done.total)}{done.fromAdvance > 0 ? `, ${npr(done.fromAdvance)} from the advance` : ""}{done.due > 0 ? `, ${npr(done.due)} left as due` : ", paid"}.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/employee/pharmacy/bills/${done.id}`} className="rounded-control bg-pine px-4 py-2 font-medium text-white">Print bill</Link>
        <Button type="button" tone="secondary" onClick={fresh}>New other sale</Button>
      </div>
    </div>
  );

  return (
    <form onSubmit={submit} className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_23rem]">
      <div className="min-w-0 space-y-5">
        <label className="block max-w-sm">
          <span className="mb-1 block text-[0.95rem] font-medium">Bill title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} list="other-sale-titles" maxLength={60} autoFocus className={field} placeholder="e.g. Lab" />
          <datalist id="other-sale-titles">{TITLES.map((t) => <option key={t} value={t} />)}</datalist>
          <span className="mt-1 block text-[0.95rem] text-ink-soft">Printed at the top of the bill. Optional.</span>
        </label>

        <fieldset className="min-w-0">
          <legend className="mb-2 text-lg font-semibold">Items</legend>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left">
              <thead className="text-[0.95rem] text-ink-soft">
                <tr><th className="pb-2 font-medium">Item</th><th className="w-24 pb-2 font-medium">Qty</th><th className="w-32 pb-2 font-medium">Rate (Rs.)</th><th className="w-32 pb-2 text-right font-medium">Amount</th><th className="w-10 pb-2"><span className="sr-only">Remove</span></th></tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.key} className="align-top">
                    <td className="py-1.5 pr-2"><input value={l.description} onChange={(e) => set(l.key, { description: e.target.value })} maxLength={120} data-desc-for={l.key}
                      aria-label={`Item ${i + 1}`} className={field} placeholder="e.g. CBC test" /></td>
                    <td className="py-1.5 pr-2"><input value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value })} inputMode="decimal" aria-label={`Quantity of item ${i + 1}`} className={cn(field, "tabular-nums")} /></td>
                    <td className="py-1.5 pr-2"><input value={l.rate} onChange={(e) => set(l.key, { rate: e.target.value })} inputMode="decimal" aria-label={`Rate of item ${i + 1}`} className={cn(field, "tabular-nums")} placeholder="0" /></td>
                    <td className="py-1.5 pt-4 text-right tabular-nums">{npr(amount(l))}</td>
                    <td className="py-1.5 pl-2 pt-3 text-right">
                      {lines.length > 1 ? <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove item ${i + 1}`}
                        className="rounded-control px-2 py-1 text-ink-soft hover:bg-sunken hover:text-alert">✕</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button type="button" tone="secondary" className="mt-3" onClick={add}>Add another line</Button>
        </fieldset>
      </div>

      <aside aria-label="Customer and payment" className="space-y-5 rounded-panel border border-line bg-canvas p-4 lg:sticky lg:top-20">
        <fieldset className="min-w-0 space-y-2">
          <legend className="mb-1.5 text-lg font-semibold">Customer</legend>
          {patient ? (
            <div className="flex items-center justify-between rounded-control border border-line px-3 py-2">
              <span>{patient.full_name} <span className="text-[0.95rem] text-ink-soft">{patient.mrn}, {patient.age}{patient.phone ? `, ${patient.phone}` : ""}</span></span>
              <button type="button" className="text-[0.95rem] font-medium text-pine" onClick={() => setPatient(null)}>Change</button>
            </div>
          ) : (
            <>
              <div className="relative">
                <input value={pq} onChange={(e) => searchPatient(e.target.value)} className={field} placeholder="Link a patient: name, phone or MRN (optional)" aria-label="Link a patient" />
                {pres.length ? (
                  <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-control border border-line bg-surface shadow-lg">
                    {pres.map((p) => <li key={p.id}><button type="button" className="w-full px-3 py-2 text-left hover:bg-sunken" onClick={() => { setPatient(p); setPq(""); setPres([]); }}>
                      {p.full_name} <span className="text-[0.95rem] text-ink-soft">{p.mrn}, {p.age}</span></button></li>)}
                  </ul>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={field} placeholder="Name (optional)" aria-label="Customer name" />
                <input value={phone} onChange={(e) => setPhone(e.target.value)} onBlur={() => setPhone(normalizePhone(phone))} type="tel" inputMode="tel" aria-label="Customer phone"
                  aria-invalid={Boolean(phoneIssue)} className={cn(field, phoneIssue && "border-alert")} placeholder="Phone (optional)" />
              </div>
              {phoneIssue ? <p role="alert" className="text-[0.95rem] text-alert">{phoneIssue}</p> : null}
            </>
          )}
        </fieldset>

        <div className="flex items-end justify-between border-t border-line pt-4">
          <div><span className="block text-ink-soft">Total</span><span className="text-[0.95rem] text-ink-soft">{filled.length} line{filled.length === 1 ? "" : "s"}, no VAT</span></div>
          <span className="text-[2.6rem] font-semibold leading-none tabular-nums" data-testid="other-total">{npr(total)}</span>
        </div>

        <fieldset className="min-w-0 space-y-3">
          <legend className="sr-only">Payment</legend>
          <div className="grid grid-cols-2 gap-2">
            <label><span className="block text-[0.95rem] text-ink-soft">Cash</span><input value={cash} onChange={(e) => setCash(e.target.value)} inputMode="decimal" className={cn(field, "tabular-nums")} /></label>
            <label><span className="block text-[0.95rem] text-ink-soft">Online</span><input value={online} onChange={(e) => setOnline(e.target.value)} inputMode="decimal" className={cn(field, "tabular-nums")} /></label>
            <label className="col-span-2"><span className="block text-[0.95rem] text-ink-soft">Online paid by</span>
              <select value={channel} onChange={(e) => setChannel(e.target.value)} className={field}><option value="">—</option>{CHANNELS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[0.95rem]">
            <button type="button" className="rounded-control border border-line px-2.5 py-1.5" onClick={() => { setCash(total.toFixed(2)); setOnline(""); }}>All cash</button>
            <button type="button" className="rounded-control border border-line px-2.5 py-1.5" onClick={() => { setOnline(total.toFixed(2)); setCash(""); }}>All online</button>
            <span className={cn(due > 0 ? "text-warn" : "text-ink-soft")}>{total > 0 ? (due > 0 ? `${npr(due)} not paid yet` : paid > total ? "More than the total" : "Paid in full") : ""}</span>
          </div>
        </fieldset>

        {err ? <p role="alert" className="text-[0.95rem] text-alert">{err}</p> : null}
        <Button type="submit" className="w-full py-3 text-base" disabled={pending} data-kbd-submit>{pending ? "Issuing…" : "Issue bill"}</Button>
      </aside>
    </form>
  );
}
