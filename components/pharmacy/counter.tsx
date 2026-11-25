"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { findPatient, issueSale, type SaleLine } from "@/app/actions/pharmacy";
import { getAdvance } from "@/app/actions/advances";
import type { CounterItem, CounterService } from "@/lib/pharmacy/data";
import type { PatientLite } from "@/lib/desk/data";
import { Button } from "@/components/ui/primitives";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const field = "w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-[0.95rem]";
const CHANNELS = [["esewa", "eSewa"], ["khalti", "Khalti"], ["fonepay", "Fonepay"], ["bank_transfer", "Bank transfer"], ["card", "Card"], ["other", "Other"]] as const;

type Row =
  | { key: string; kind: "item"; itemId: string; unitId: string; qty: string; disc: string; batchId: string; rxItemId: string | null; rxText: string | null }
  | { key: string; kind: "service"; serviceId: string; qty: string; disc: string };
export type RxPrefill = { patient: PatientLite; rxNumber: string; lines: { prescription_item_id: string; text: string; qty: number | null }[] };

export function CounterSale({ storeId, items, services, canOverride, canSellRx, allowCredit, prefill }: {
  storeId: string; items: CounterItem[]; services: CounterService[]; canOverride: boolean; canSellRx: boolean; allowCredit: boolean; prefill?: RxPrefill | null;
}) {
  const key = useRef(crypto.randomUUID());
  const seq = useRef(0);
  const nk = () => `r${++seq.current}`;
  const [rows, setRows] = useState<Row[]>(() => (prefill?.lines ?? []).map((l) => ({ key: `rx-${l.prescription_item_id}`, kind: "item", itemId: "", unitId: "", qty: l.qty ? String(l.qty) : "1", disc: "0", batchId: "", rxItemId: l.prescription_item_id, rxText: l.text })));
  const [q, setQ] = useState("");
  const [patient, setPatient] = useState<PatientLite | null>(prefill?.patient ?? null);
  const [pq, setPq] = useState(""); const [pres, setPres] = useState<PatientLite[]>([]);
  const [name, setName] = useState(""); const [phone, setPhone] = useState("");
  const [ext, setExt] = useState({ prescriber_name: "", prescriber_reg_no: "", facility: "", rx_date: "" });
  const [cash, setCash] = useState(""); const [online, setOnline] = useState(""); const [channel, setChannel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; no: string; total: number; due: number; fromAdvance: number } | null>(null);
  const [heldFor, setHeldFor] = useState<{ id: string; balance: number } | null>(null);
  const [pending, start] = useTransition();

  const item = (id: string) => items.find((i) => i.id === id);
  const matches = q.trim().length < 2 ? [] : items.filter((i) => `${i.name} ${i.generic ?? ""} ${i.code} ${i.barcodes.map((b) => b.code).join(" ")}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8);
  // A scanned barcode (exact match, then Enter) adds one of that unit, or one more if the line is there.
  const scan = (code: string) => {
    const c = code.trim().toLowerCase();
    for (const it of items) {
      const b = it.barcodes.find((x) => x.code.toLowerCase() === c);
      if (!b) continue;
      if (it.blocked) { setErr(`${it.name} can't be sold here.`); setQ(""); return true; }
      setErr(null);
      setRows((rs) => {
        const at = rs.findIndex((r) => r.kind === "item" && r.itemId === it.id && r.unitId === b.unit_id && !r.batchId && !r.rxItemId);
        if (at >= 0) return rs.map((r, n) => (n === at && r.kind === "item" ? { ...r, qty: String((Number(r.qty) || 0) + 1) } : r));
        return [...rs, { key: nk(), kind: "item", itemId: it.id, unitId: b.unit_id, qty: "1", disc: "0", batchId: "", rxItemId: null, rxText: null }];
      });
      setQ("");
      return true;
    }
    return false;
  };
  const svcMatches = q.trim().length < 2 ? [] : services.filter((s) => s.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 3);

  // Preview: which lots each line takes (earliest expiry first, after earlier lines of the same item).
  const preview = useMemo(() => {
    const used = new Map<string, number>();
    return rows.map((r) => {
      if (r.kind === "service") {
        const s = services.find((x) => x.id === r.serviceId); const gross = (Number(r.qty) || 0) * (s?.price ?? 0);
        return { gross, net: gross * (1 - (Number(r.disc) || 0) / 100), tax: 0, lots: [] as string[], short: false };
      }
      const it = item(r.itemId); const u = it?.units.find((x) => x.id === r.unitId);
      if (!it || !u) return { gross: 0, net: 0, tax: 0, lots: [], short: false };
      let need = Math.round((Number(r.qty) || 0) * u.factor_to_base * 1000) / 1000; let gross = 0; const lots: string[] = [];
      const pool = r.batchId ? it.lots.filter((l) => l.batch_id === r.batchId) : it.lots;
      for (const l of pool) {
        if (need <= 0) break;
        const left = l.qty - (used.get(l.batch_id) ?? 0); if (left <= 0) continue;
        const take = Math.min(left, need); need -= take; used.set(l.batch_id, (used.get(l.batch_id) ?? 0) + take);
        gross += take * l.price; lots.push(`${l.batch_no}${l.expiry_date ? ` (exp ${l.expiry_date.slice(0, 7)})` : ""} × ${take}`);
      }
      gross = Math.round(gross * 100) / 100; const net = gross * (1 - (Number(r.disc) || 0) / 100);
      return { gross, net, tax: it.vat ? Math.round(net * 13) / 100 : 0, lots, short: need > 0.0005 };
    });
  }, [rows, items, services]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = Math.round(preview.reduce((s, p) => s + p.net + p.tax, 0) * 100) / 100;
  // M-52: a linked patient's advance pays first; take only the rest.
  useEffect(() => {
    let live = true;
    if (patient) void getAdvance(patient.id).then((r) => { if (live) setHeldFor({ id: patient.id, balance: r.ok ? r.summary.balance : 0 }); });
    return () => { live = false; };
  }, [patient]);
  const held = patient && heldFor?.id === patient.id ? heldFor.balance : 0;
  const fromAdvance = patient ? Math.max(0, Math.min(held, total)) : 0;
  const toTake = Math.round((total - fromAdvance) * 100) / 100;
  const paid = (Number(cash) || 0) + (Number(online) || 0);
  const needsExt = rows.some((r) => r.kind === "item" && !r.rxItemId && item(r.itemId)?.rx_only);

  const set = (k: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === k ? ({ ...r, ...patch } as Row) : r)));
  const addItem = (it: CounterItem) => { setRows((rs) => [...rs, { key: nk(), kind: "item", itemId: it.id, unitId: it.units[0]?.id ?? "", qty: "1", disc: "0", batchId: "", rxItemId: null, rxText: null }]); setQ(""); };
  const addService = (s: CounterService) => { setRows((rs) => [...rs, { key: nk(), kind: "service", serviceId: s.id, qty: "1", disc: "0" }]); setQ(""); };
  const searchPatient = (v: string) => { setPq(v); if (v.trim().length >= 2) start(async () => setPres(await findPatient(v))); else setPres([]); };

  function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    const ready = rows.filter((r) => r.kind === "service" || r.itemId);
    if (!ready.length) { setErr("Add at least one item."); return; }
    if (rows.some((r) => r.kind === "item" && !r.itemId)) { setErr("Choose the medicine for every prescription line, or remove it."); return; }
    const lines: SaleLine[] = ready.map((r) => r.kind === "service"
      ? { kind: "service", service_id: r.serviceId, qty: Number(r.qty), discount_pct: Number(r.disc) || 0 }
      : { kind: "item", item_id: r.itemId, unit_id: r.unitId, qty: Number(r.qty), discount_pct: Number(r.disc) || 0, batch_id: r.batchId || null, prescription_item_id: r.rxItemId });
    start(async () => {
      const res = await issueSale({ idempotencyKey: key.current, storeId, patientId: patient?.id ?? null, customerName: name, customerPhone: phone, lines,
        externalRx: needsExt ? ext : null, cash: Number(cash) || 0, online: Number(online) || 0, channel: channel || null });
      if (res.ok) setDone(res); else setErr(res.error);
    });
  }
  function fresh() { key.current = crypto.randomUUID(); setRows([]); setPatient(null); setName(""); setPhone(""); setCash(""); setOnline(""); setChannel(""); setExt({ prescriber_name: "", prescriber_reg_no: "", facility: "", rx_date: "" }); setDone(null); setErr(null); }

  if (done) return (
    <div className="rounded-panel border border-ok/40 bg-ok/5 p-5" role="status">
      <p className="text-lg font-medium">Bill {done.no} issued: {npr(done.total)}{done.fromAdvance > 0 ? `, ${npr(done.fromAdvance)} from the advance` : ""}{done.due > 0 ? `, ${npr(done.due)} left as due` : ", paid"}.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/employee/pharmacy/bills/${done.id}`} className="rounded-control bg-pine px-4 py-2 font-medium text-white">Print bill</Link>
        <Button type="button" tone="secondary" onClick={fresh}>New sale</Button>
      </div>
    </div>
  );

  return (
    <form onSubmit={submit} className="space-y-5">
      {prefill ? <p className="rounded-control bg-pine/5 px-3 py-2 text-sm">Dispensing {prefill.rxNumber} for {prefill.patient.full_name}. Choose the medicine for each line; reduce a quantity to dispense part.</p> : null}
      <div className="relative">
        <label className="block"><span className="mb-1 block text-sm font-medium">Add medicine or service</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} className={field} placeholder="Scan a barcode, or type a brand, generic or code" autoFocus={!prefill}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (!scan(q) && matches.length === 1) addItem(matches[0]!); } }} aria-label="Add medicine or service" /></label>
        {matches.length || svcMatches.length ? (
          <ul className="absolute z-10 mt-1 w-full divide-y divide-line rounded-panel border border-line bg-surface shadow-sm">
            {matches.map((i) => (
              <li key={i.id}><button type="button" disabled={i.blocked} onClick={() => addItem(i)} className="flex w-full justify-between gap-3 px-4 py-2 text-left hover:bg-pine/5 disabled:opacity-50">
                <span><span className="font-medium">{i.name}</span> <span className="text-sm text-ink-soft">{[i.generic, i.strength].filter(Boolean).join(" ")}</span>{i.rx_only ? <span className="ml-2 text-xs text-warn">Rx</span> : null}{i.blocked ? <span className="ml-2 text-xs text-alert">blocked</span> : null}</span>
                <span className="text-sm text-ink-faint">{i.available} {i.units[0]?.name}{i.lots[0]?.expiry_date ? `, exp ${i.lots[0].expiry_date.slice(0, 7)}` : ""}</span>
              </button></li>
            ))}
            {svcMatches.map((s) => <li key={s.id}><button type="button" onClick={() => addService(s)} className="flex w-full justify-between px-4 py-2 text-left hover:bg-pine/5"><span>{s.name}</span><span className="text-sm text-ink-faint">{npr(s.price)}</span></button></li>)}
          </ul>
        ) : null}
      </div>

      {rows.length ? (
        <ul className="divide-y divide-line rounded-panel border border-line">
          {rows.map((r, idx) => {
            const p = preview[idx] ?? { gross: 0, net: 0, tax: 0, lots: [] as string[], short: false };
            if (r.kind === "service") {
              const s = services.find((x) => x.id === r.serviceId);
              return (
                <li key={r.key} className="grid items-end gap-3 px-4 py-3 sm:grid-cols-[1fr_5rem_5rem_7rem_auto]">
                  <div className="font-medium">{s?.name}</div>
                  <label><span className="block text-xs text-ink-faint">Qty</span><input type="number" min={1} step={1} value={r.qty} onChange={(e) => set(r.key, { qty: e.target.value })} className={field} /></label>
                  <label><span className="block text-xs text-ink-faint">Disc. %</span><input type="number" min={0} max={100} value={r.disc} onChange={(e) => set(r.key, { disc: e.target.value })} className={field} /></label>
                  <div className="text-right tabular-nums">{npr(p.net)}</div>
                  <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="text-sm text-alert">Remove</button>
                </li>
              );
            }
            const it = item(r.itemId);
            return (
              <li key={r.key} className="space-y-2 px-4 py-3">
                {r.rxText ? <div className="text-sm"><span className="text-ink-faint">Prescribed:</span> <span className="font-medium">{r.rxText}</span></div> : null}
                <div className="grid items-end gap-3 sm:grid-cols-[1fr_6rem_6rem_5rem_7rem_auto]">
                  {r.rxText ? (
                    <label><span className="block text-xs text-ink-faint">Medicine</span>
                      <select value={r.itemId} onChange={(e) => { const x = item(e.target.value); set(r.key, { itemId: e.target.value, unitId: x?.units[0]?.id ?? "", batchId: "" }); }} className={field}>
                        <option value="">Choose</option>{items.filter((x) => !x.blocked).map((x) => <option key={x.id} value={x.id}>{x.name}{x.generic ? ` (${x.generic})` : ""}</option>)}</select></label>
                  ) : <div><div className="font-medium">{it?.name}</div><div className="text-sm text-ink-soft">{[it?.generic, it?.strength].filter(Boolean).join(" ")}{it?.rx_only ? " · needs a prescription" : ""}</div></div>}
                  <label><span className="block text-xs text-ink-faint">Qty</span><input type="number" min={0.001} step="any" value={r.qty} onChange={(e) => set(r.key, { qty: e.target.value })} className={field} /></label>
                  <label><span className="block text-xs text-ink-faint">Unit</span>
                    <select value={r.unitId} onChange={(e) => set(r.key, { unitId: e.target.value })} className={field}>{it?.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
                  <label><span className="block text-xs text-ink-faint">Disc. %</span><input type="number" min={0} max={100} value={r.disc} onChange={(e) => set(r.key, { disc: e.target.value })} className={field} /></label>
                  <div className="text-right tabular-nums">{npr(p.net + p.tax)}</div>
                  <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="text-sm text-alert">Remove</button>
                </div>
                {it ? <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className={p.short ? "text-alert" : "text-ink-soft"}>{p.short ? `Only ${it.available} ${it.units[0]?.name} sellable here.` : p.lots.length ? `From batch ${p.lots.join(", ")}` : ""}</span>
                  {canOverride && it.lots.length > 1 ? <select value={r.batchId} onChange={(e) => set(r.key, { batchId: e.target.value })} className="rounded-control border border-line px-2 py-1 text-sm" aria-label="Batch">
                    <option value="">Earliest expiry first</option>{it.lots.map((l) => <option key={l.batch_id} value={l.batch_id}>{l.batch_no} exp {l.expiry_date ?? "—"} ({l.qty} left)</option>)}</select> : null}
                </div> : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="text-ink-soft">Search above to add medicines. Expired and blocked batches are never offered.</p>}

      {needsExt ? (
        <fieldset className="rounded-panel border border-warn/40 p-4">
          <legend className="px-1 text-sm font-medium">Outside prescription</legend>
          {!canSellRx ? <p className="text-sm text-alert">Only a verified pharmacist can sell prescription medicines.</p> : (
            <div className="grid gap-3 sm:grid-cols-4">
              <label className="sm:col-span-2"><span className="block text-xs text-ink-faint">Prescriber</span><input required value={ext.prescriber_name} onChange={(e) => setExt({ ...ext, prescriber_name: e.target.value })} className={field} placeholder="Dr. …" /></label>
              <label><span className="block text-xs text-ink-faint">NMC no.</span><input value={ext.prescriber_reg_no} onChange={(e) => setExt({ ...ext, prescriber_reg_no: e.target.value })} className={field} /></label>
              <label><span className="block text-xs text-ink-faint">Date</span><input type="date" value={ext.rx_date} onChange={(e) => setExt({ ...ext, rx_date: e.target.value })} className={field} /></label>
              <label className="sm:col-span-4"><span className="block text-xs text-ink-faint">Hospital or clinic</span><input value={ext.facility} onChange={(e) => setExt({ ...ext, facility: e.target.value })} className={field} /></label>
            </div>
          )}
        </fieldset>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-medium">Customer</legend>
          {patient ? (
            <div className="flex items-center justify-between rounded-control border border-line px-3 py-2"><span>{patient.full_name} <span className="text-sm text-ink-faint">{patient.mrn}, {patient.age}</span></span>
              {!prefill ? <button type="button" onClick={() => setPatient(null)} className="text-sm text-pine">Change</button> : null}</div>
          ) : (
            <>
              <div className="relative">
                <input value={pq} onChange={(e) => searchPatient(e.target.value)} className={field} placeholder="Link a patient: name, phone or MRN (optional)" />
                {pres.length ? <ul className="absolute z-10 mt-1 w-full divide-y divide-line rounded-panel border border-line bg-surface shadow-sm">{pres.map((x) => (
                  <li key={x.id}><button type="button" onClick={() => { setPatient(x); setPres([]); setPq(""); }} className="w-full px-3 py-2 text-left hover:bg-pine/5">{x.full_name} <span className="text-sm text-ink-faint">{x.mrn} · {x.phone ?? ""}</span></button></li>))}</ul> : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <input value={name} onChange={(e) => setName(e.target.value)} className={field} placeholder="Name (optional)" />
                <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" className={field} placeholder="Phone (optional)" />
              </div>
            </>
          )}
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-medium">Payment</legend>
          <div className="flex items-baseline justify-between"><span className="text-ink-soft">Total (estimate)</span><span className="text-2xl font-semibold tabular-nums">{npr(total)}</span></div>
          {fromAdvance > 0 ? <div className="flex items-baseline justify-between text-sm"><span className="text-ink-soft">From the advance ({npr(held)} held)</span><span className="tabular-nums">− {npr(fromAdvance)}; take {npr(toTake)}</span></div> : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <label><span className="block text-xs text-ink-faint">Cash</span><input type="number" min={0} step="0.01" value={cash} onChange={(e) => setCash(e.target.value)} className={field} /></label>
            <label><span className="block text-xs text-ink-faint">Online</span><input type="number" min={0} step="0.01" value={online} onChange={(e) => setOnline(e.target.value)} className={field} /></label>
            <label><span className="block text-xs text-ink-faint">Paid by</span><select value={channel} onChange={(e) => setChannel(e.target.value)} disabled={!Number(online)} className={field}><option value="">—</option>{CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <button type="button" onClick={() => { setCash(String(toTake)); setOnline(""); }} className="rounded-control border border-line px-2 py-1">All cash</button>
            <button type="button" onClick={() => { setOnline(String(toTake)); setCash(""); }} className="rounded-control border border-line px-2 py-1">All online</button>
            <span className="self-center text-ink-faint">{paid < toTake ? (allowCredit && patient ? `${npr(toTake - paid)} will be left as due` : `${npr(toTake - paid)} still to take`) : paid > toTake ? `Change ${npr(paid - toTake)}: enter only the amount to take` : "Paid in full"}</span>
          </div>
        </fieldset>
      </div>

      {err ? <p role="alert" className="text-alert">{err}</p> : null}
      <div className="flex justify-end"><Button type="submit" disabled={pending || !rows.length}>{pending ? "Issuing…" : "Issue bill"}</Button></div>
    </form>
  );
}
