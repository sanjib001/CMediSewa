"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { findPatient, holdStock, issueSale, type SaleLine } from "@/app/actions/pharmacy";
import { getAdvance } from "@/app/actions/advances";
import type { CounterItem, CounterService } from "@/lib/pharmacy/data";
import type { PatientLite } from "@/lib/desk/data";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { normalizePhone, phoneProblem } from "@/lib/phone";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const field = "w-full rounded-control border border-line-strong bg-surface px-3 py-2.5 text-base";
const CHANNELS = [["esewa", "eSewa"], ["khalti", "Khalti"], ["fonepay", "Fonepay"], ["bank_transfer", "Bank transfer"], ["card", "Card"], ["other", "Other"]] as const;

type Row =
  | { key: string; kind: "item"; itemId: string; unitId: string; qty: string; disc: string; batchId: string; rxItemId: string | null; rxText: string | null;
      holdLineId?: string | null; held?: { batch_no: string; expiry_date: string | null; qty: number; price: number } | null;
      prescribedId?: string | null; subReason?: string }
  | { key: string; kind: "service"; serviceId: string; qty: string; disc: string };
export type RxPrefill = { patient: PatientLite; rxNumber: string; lines: { prescription_item_id: string; text: string; qty: number | null; item_id?: string | null }[] };
// D-147: quick reasons for giving another brand of the same medicine.
const SUB_REASONS = ["Prescribed brand out of stock", "Patient asked for this brand", "Lower price for the patient"];
/** M-45: collecting a hold. Each line is one held lot. */
export type HoldStart = {
  holdId: string; holdNo: string; patient: PatientLite | null; name: string | null; phone: string | null;
  lines: { hold_line_id: string; item_id: string; unit_id: string; qty: number; batch_no: string; expiry_date: string | null; price: number; held_base: number; prescription_item_id: string | null; substitution_reason?: string | null }[];
};
const HOLD_HOURS = [["24", "1 day"], ["48", "2 days"], ["72", "3 days"], ["168", "7 days"]] as const;

export function CounterSale({ storeId, items, services, canOverride, canSellRx, allowCredit, prefill, hold }: {
  storeId: string; items: CounterItem[]; services: CounterService[]; canOverride: boolean; canSellRx: boolean; allowCredit: boolean; prefill?: RxPrefill | null; hold?: HoldStart | null;
}) {
  const key = useRef(crypto.randomUUID());
  const seq = useRef(0);
  const nk = () => `r${++seq.current}`;
  const [rows, setRows] = useState<Row[]>(() => hold
    ? hold.lines.map((l) => ({ key: `hold-${l.hold_line_id}`, kind: "item", itemId: l.item_id, unitId: l.unit_id, qty: String(l.qty), disc: "0", batchId: "", rxItemId: l.prescription_item_id, rxText: null,
        holdLineId: l.hold_line_id, held: { batch_no: l.batch_no, expiry_date: l.expiry_date, qty: l.held_base, price: l.price }, subReason: l.substitution_reason ?? "" }))
    : (prefill?.lines ?? []).map((l) => {
        // The prescribed catalogue item is chosen when it is in stock; else the first brand of the same medicine that is.
        const own = l.item_id ? items.find((i) => i.id === l.item_id) : undefined;
        const alt = own && own.available <= 0 ? items.find((i) => i.id !== own.id && own.equiv && i.equiv === own.equiv && !i.blocked && i.available > 0) : undefined;
        const pick = alt ?? own;
        return { key: `rx-${l.prescription_item_id}`, kind: "item", itemId: pick?.id ?? "", unitId: pick?.units[0]?.id ?? "", qty: l.qty ? String(l.qty) : "1", disc: "0", batchId: "",
          rxItemId: l.prescription_item_id, rxText: l.text, prescribedId: l.item_id ?? null, subReason: alt ? SUB_REASONS[0] : "" };
      }));
  const [q, setQ] = useState("");
  // Keyboard selling (owner): ↑/↓ pick among the matches, Enter adds the picked one and moves to its
  // Qty; Enter on Qty → Unit → Disc %, and Enter on Disc % comes back here for the next medicine.
  // Enter in the empty search box goes on to the payment (Cash).
  const [hi, setHi] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const cashRef = useRef<HTMLInputElement>(null);
  const focusQty = useRef<string | null>(null);
  const [patient, setPatient] = useState<PatientLite | null>(hold ? hold.patient : prefill?.patient ?? null);
  const [pq, setPq] = useState(""); const [pres, setPres] = useState<PatientLite[]>([]);
  const [name, setName] = useState(hold?.name ?? ""); const [phone, setPhone] = useState(hold?.phone ?? "");
  const [holdHours, setHoldHours] = useState("48");
  const [heldDone, setHeldDone] = useState<{ no: string; until: string } | null>(null);
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
  // D-147: other brands of the same medicine (generic, strength, form) with stock here.
  const subsFor = (it: CounterItem | undefined) => (it?.equiv ? items.filter((x) => x.id !== it.id && x.equiv === it.equiv && !x.blocked && x.available > 0) : []);
  const needsReason = (r: Row) => r.kind === "item" && Boolean(r.prescribedId) && Boolean(r.itemId) && r.itemId !== r.prescribedId;
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
      if (r.held) {   // a held lot: only what was held, at that lot's price
        const take = Math.min(need, r.held.qty); gross = Math.round(take * r.held.price * 100) / 100; const net = gross * (1 - (Number(r.disc) || 0) / 100);
        return { gross, net, tax: it.vat ? Math.round(net * 13) / 100 : 0, lots: [`${r.held.batch_no}${r.held.expiry_date ? ` (exp ${r.held.expiry_date.slice(0, 7)})` : ""} × ${take}`], short: need > r.held.qty + 0.0005 };
      }
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
  const addItem = (it: CounterItem) => { const k = nk(); focusQty.current = k; setRows((rs) => [...rs, { key: k, kind: "item", itemId: it.id, unitId: it.units[0]?.id ?? "", qty: "1", disc: "0", batchId: "", rxItemId: null, rxText: null }]); setQ(""); setHi(0); };
  const addService = (s: CounterService) => { const k = nk(); focusQty.current = k; setRows((rs) => [...rs, { key: k, kind: "service", serviceId: s.id, qty: "1", disc: "0" }]); setQ(""); setHi(0); };
  // A line just added: put the cursor in its Qty, number selected, ready to type over.
  useEffect(() => {
    if (!focusQty.current) return;
    const el = document.querySelector<HTMLInputElement>(`[data-qty-for="${focusQty.current}"]`);
    if (el) { el.focus(); el.select(); focusQty.current = null; }
  }, [rows]);
  // What Enter adds for each match: the item, or for one with none in stock the first same medicine in stock.
  const options: ({ label: string; add: () => void } | { label: string; add: null; why: string })[] = [
    ...matches.map((i) => {
      if (i.blocked) return { label: i.name, add: null, why: `${i.name} can't be sold here.` };
      if (i.available > 0) return { label: i.name, add: () => addItem(i) };
      const s = subsFor(i)[0];
      return s ? { label: s.name, add: () => addItem(s) } : { label: i.name, add: null, why: `${i.name}: none in stock, and no other brand of the same medicine.` };
    }),
    ...svcMatches.map((s) => ({ label: s.name, add: () => addService(s) })),
  ];
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!options.length) return;
      e.preventDefault();
      setHi((h) => (h + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (scan(q)) return;
    if (!q.trim()) { if (rows.length) cashRef.current?.focus(); return; }
    const o = options[Math.min(hi, options.length - 1)];
    if (!o) return;
    if (o.add) { setErr(null); o.add(); } else setErr(o.why);
  };
  // Enter on a line's Disc % goes back to the search box for the next medicine.
  const backToSearch = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    searchRef.current?.focus();
  };
  const searchPatient = (v: string) => { setPq(v); if (v.trim().length >= 2) start(async () => setPres(await findPatient(v))); else setPres([]); };

  function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    const ready = rows.filter((r) => r.kind === "service" || r.itemId);
    if (!ready.length) { setErr("Add at least one item."); return; }
    if (rows.some((r) => r.kind === "item" && !r.itemId)) { setErr("Choose the medicine for every prescription line, or remove it."); return; }
    if (rows.some((r) => needsReason(r) && (r.kind !== "item" || (r.subReason ?? "").trim().length < 3))) { setErr("Give the reason for each brand that isn't the one prescribed."); return; }
    const lines: SaleLine[] = ready.map((r) => r.kind === "service"
      ? { kind: "service", service_id: r.serviceId, qty: Number(r.qty), discount_pct: Number(r.disc) || 0 }
      : { kind: "item", item_id: r.itemId, unit_id: r.unitId, qty: Number(r.qty), discount_pct: Number(r.disc) || 0, batch_id: r.batchId || null, prescription_item_id: r.rxItemId, hold_line_id: r.holdLineId ?? null, substitution_reason: needsReason(r) || r.holdLineId ? (r.subReason ?? "").trim() || null : null });
    start(async () => {
      const res = await issueSale({ idempotencyKey: key.current, storeId, patientId: patient?.id ?? null, customerName: patient ? "" : name, customerPhone: patient ? "" : phone, lines,
        externalRx: needsExt ? ext : null, cash: Number(cash) || 0, online: Number(online) || 0, channel: channel || null });
      if (res.ok) setDone(res); else setErr(res.error);
    });
  }
  function fresh() { key.current = crypto.randomUUID(); setRows([]); setPatient(null); setName(""); setPhone(""); setCash(""); setOnline(""); setChannel(""); setExt({ prescriber_name: "", prescriber_reg_no: "", facility: "", rx_date: "" }); setDone(null); setHeldDone(null); setErr(null); }

  // M-45: keep these medicines aside for the customer instead of billing now.
  function holdForLater() {
    setErr(null);
    const ready = rows.filter((r): r is Extract<Row, { kind: "item" }> => r.kind === "item" && Boolean(r.itemId));
    if (!ready.length) { setErr("Add the medicines to hold."); return; }
    if (rows.some((r) => r.kind === "service")) { setErr("Services can't be held. Remove them, or bill them now."); return; }
    if (rows.some((r) => r.kind === "item" && !r.itemId)) { setErr("Choose the medicine for every prescription line, or remove it."); return; }
    if (!patient && name.trim().length < 2) { setErr("Link a patient, or enter the customer's name, to hold stock."); return; }
    if (ready.some((r) => needsReason(r) && (r.subReason ?? "").trim().length < 3)) { setErr("Give the reason for each brand that isn't the one prescribed."); return; }
    start(async () => {
      const res = await holdStock({ idempotencyKey: key.current, storeId, patientId: patient?.id ?? null, customerName: patient ? "" : name, customerPhone: patient ? "" : phone, hours: Number(holdHours),
        lines: ready.map((r) => ({ item_id: r.itemId, unit_id: r.unitId, qty: Number(r.qty), batch_id: r.batchId || null, prescription_item_id: r.rxItemId,
          substitution_reason: needsReason(r) ? (r.subReason ?? "").trim() : null })) });
      if (res.ok) setHeldDone({ no: res.no, until: new Date(res.expiresAt).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" }) });
      else setErr(res.error);
    });
  }

  if (heldDone) return (
    <div className="rounded-panel border border-ok/40 bg-ok/5 p-5" role="status">
      <p className="text-lg font-medium">Held as {heldDone.no} until {heldDone.until}. Nobody else can sell it; collect it from the Holds tab.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/employee/pharmacy?tab=holds&store=${storeId}`} className="rounded-control bg-pine px-4 py-2 font-medium text-white">See holds</Link>
        <Button type="button" tone="secondary" onClick={fresh}>New sale</Button>
      </div>
    </div>
  );

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
    <form onSubmit={submit} className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_23rem]">
      <div className="min-w-0 space-y-5">
      {hold ? <p className="rounded-control bg-pine/5 px-3 py-2 text-[0.95rem]">Collecting hold {hold.holdNo}{hold.patient ? ` for ${hold.patient.full_name}` : hold.name ? ` for ${hold.name}` : ""}. Each line sells from the batch kept aside; reduce a quantity to take less, and the rest goes back to the shelf.</p> : null}
      {prefill ? <p className="rounded-control bg-pine/5 px-3 py-2 text-[0.95rem]">Dispensing {prefill.rxNumber} for {prefill.patient.full_name}. Choose the medicine for each line; reduce a quantity to dispense part.</p> : null}
      <div className="relative">
        <label className="block"><span className="mb-1 block text-[0.95rem] font-medium">Add medicine or service</span>
          <input ref={searchRef} value={q} onChange={(e) => { setQ(e.target.value); setHi(0); }} className={field} placeholder="Scan a barcode, or type a brand, generic or code" autoFocus={!prefill}
            onKeyDown={onSearchKey} aria-label="Add medicine or service" role="combobox" aria-expanded={options.length > 0} aria-controls="counter-matches" /></label>
        {options.length ? <p className="mt-1 text-sm text-ink-soft">↑ ↓ to choose, Enter to add{options[Math.min(hi, options.length - 1)] ? `: ${options[Math.min(hi, options.length - 1)]!.label}` : ""}</p>
          : rows.length && !q ? <p className="mt-1 text-sm text-ink-soft">Enter here goes to the payment.</p> : null}
        {matches.length || svcMatches.length ? (
          <ul id="counter-matches" className="absolute z-10 mt-1 w-full divide-y divide-line rounded-panel border border-line bg-surface shadow-sm">
            {matches.map((i, idx) => (
              <li key={i.id} className={cn(idx === hi && "bg-pine/10")} data-active={idx === hi || undefined}>{i.available <= 0 && !i.blocked ? (
                <div className="px-4 py-2">
                  <div className="flex justify-between gap-3"><span><span className="font-medium">{i.name}</span> <span className="text-[0.95rem] text-ink-soft">{[i.generic, i.strength].filter(Boolean).join(" ")}</span></span><span className="text-[0.95rem] text-alert">none in stock</span></div>
                  {subsFor(i).length ? <div className="mt-1 flex flex-wrap items-center gap-2 text-[0.95rem]"><span className="text-ink-soft">Same medicine:</span>
                    {subsFor(i).slice(0, 4).map((s) => <button key={s.id} type="button" onClick={() => addItem(s)} className="rounded-control border border-pine/40 px-2 py-0.5 text-pine hover:bg-pine/5">{s.name} ({s.available} {s.units.find((u) => u.factor_to_base === 1)?.name ?? ""})</button>)}</div>
                    : <div className="mt-1 text-[0.95rem] text-ink-soft">No other brand of the same medicine in stock.</div>}
                </div>
              ) : <button type="button" disabled={i.blocked} onClick={() => addItem(i)} className="flex w-full justify-between gap-3 px-4 py-2 text-left hover:bg-pine/5 disabled:opacity-50">
                <span><span className="font-medium">{i.name}</span> <span className="text-[0.95rem] text-ink-soft">{[i.generic, i.strength].filter(Boolean).join(" ")}</span>{i.rx_only ? <span className="ml-2 text-sm text-warn">Rx</span> : null}{i.blocked ? <span className="ml-2 text-sm text-alert">blocked</span> : null}</span>
                <span className="text-[0.95rem] text-ink-soft">{i.available} {i.units[0]?.name}{i.lots[0]?.expiry_date ? `, exp ${i.lots[0].expiry_date.slice(0, 7)}` : ""}</span>
              </button>}</li>
            ))}
            {svcMatches.map((s, j) => <li key={s.id} className={cn(matches.length + j === hi && "bg-pine/10")} data-active={matches.length + j === hi || undefined}><button type="button" onClick={() => addService(s)} className="flex w-full justify-between px-4 py-2 text-left hover:bg-pine/5"><span>{s.name}</span><span className="text-[0.95rem] text-ink-soft">{npr(s.price)}</span></button></li>)}
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
                  <label><span className="block text-sm text-ink-soft">Qty</span><input type="number" min={1} step={1} value={r.qty} onChange={(e) => set(r.key, { qty: e.target.value })} data-qty-for={r.key} className={field} /></label>
                  <label><span className="block text-sm text-ink-soft">Disc. %</span><input type="number" min={0} max={100} value={r.disc} onChange={(e) => set(r.key, { disc: e.target.value })} onKeyDown={backToSearch} className={field} /></label>
                  <div className="text-right tabular-nums">{npr(p.net)}</div>
                  <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="text-[0.95rem] text-alert">Remove</button>
                </li>
              );
            }
            const it = item(r.itemId);
            return (
              <li key={r.key} className="space-y-2 px-4 py-3">
                {r.rxText ? <div className="text-[0.95rem]"><span className="text-ink-soft">Prescribed:</span> <span className="font-medium">{r.rxText}</span></div> : null}
                <div className="grid items-end gap-3 sm:grid-cols-[1fr_6rem_6rem_5rem_7rem_auto]">
                  {r.rxText ? (
                    <label><span className="block text-sm text-ink-soft">Medicine</span>
                      <select value={r.itemId} onChange={(e) => { const x = item(e.target.value); set(r.key, { itemId: e.target.value, unitId: x?.units[0]?.id ?? "", batchId: "" }); }} className={field}>
                        <option value="">Choose</option>{(r.prescribedId && item(r.prescribedId) ? [item(r.prescribedId)!, ...items.filter((x) => x.id !== r.prescribedId && item(r.prescribedId!)!.equiv && x.equiv === item(r.prescribedId!)!.equiv)] : items)
                          .filter((x) => !x.blocked).map((x) => <option key={x.id} value={x.id}>{x.name}{x.generic ? ` (${x.generic})` : ""}{x.id === r.prescribedId ? " · prescribed" : ""}{x.available <= 0 ? " · none in stock" : ""}</option>)}</select></label>
                  ) : <div><div className="font-medium">{it?.name}</div><div className="text-[0.95rem] text-ink-soft">{[it?.generic, it?.strength].filter(Boolean).join(" ")}{it?.rx_only ? " · needs a prescription" : ""}</div></div>}
                  <label><span className="block text-sm text-ink-soft">Qty</span><input type="number" min={0.001} step="any" value={r.qty} onChange={(e) => set(r.key, { qty: e.target.value })} data-qty-for={r.key} aria-label={`Quantity of ${it?.name ?? "medicine"}`} className={field} /></label>
                  <label><span className="block text-sm text-ink-soft">Unit</span>
                    <select value={r.unitId} onChange={(e) => set(r.key, { unitId: e.target.value })} disabled={Boolean(r.held)} className={field}>{it?.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
                  <label><span className="block text-sm text-ink-soft">Disc. %</span><input type="number" min={0} max={100} value={r.disc} onChange={(e) => set(r.key, { disc: e.target.value })} onKeyDown={backToSearch} aria-label={`Discount on ${it?.name ?? "medicine"}`} className={field} /></label>
                  <div className="text-right tabular-nums">{npr(p.net + p.tax)}</div>
                  <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="text-[0.95rem] text-alert">Remove</button>
                </div>
                {needsReason(r) ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-control bg-warn/10 px-3 py-2 text-[0.95rem]">
                    <span>Another brand than prescribed ({item(r.prescribedId!)?.name}). Reason:</span>
                    <input value={r.subReason ?? ""} onChange={(e) => set(r.key, { subReason: e.target.value })} list="sub-reasons" maxLength={200} aria-label="Reason for another brand" required
                      className="min-w-56 flex-1 rounded-control border border-line-strong bg-surface px-2 py-1" />
                  </div>
                ) : null}
                {r.rxText && it && it.available <= 0 && !r.held && subsFor(it).length ? (
                  <div className="flex flex-wrap items-center gap-2 text-[0.95rem]"><span className="text-alert">None in stock.</span><span className="text-ink-soft">Same medicine:</span>
                    {subsFor(it).slice(0, 4).map((s) => <button key={s.id} type="button" onClick={() => set(r.key, { itemId: s.id, unitId: s.units[0]?.id ?? "", batchId: "", subReason: r.subReason || SUB_REASONS[0] })}
                      className="rounded-control border border-pine/40 px-2 py-0.5 text-pine hover:bg-pine/5">{s.name} ({s.available})</button>)}</div>
                ) : null}
                {it && r.held ? <div className={p.short ? "text-[0.95rem] text-alert" : "text-[0.95rem] text-ink-soft"}>{p.short ? `Only ${r.held.qty} ${it.units.find((u) => u.is_base)?.name ?? ""} were held. Add another line for more.` : `Held: batch ${p.lots.join(", ")}`}</div>
                : it ? <div className="flex flex-wrap items-center gap-3 text-[0.95rem]">
                  <span className={p.short ? "text-alert" : "text-ink-soft"}>{p.short ? `Only ${it.available} ${it.units[0]?.name} sellable here.` : p.lots.length ? `From batch ${p.lots.join(", ")}` : ""}</span>
                  {canOverride && it.lots.length > 1 ? <select value={r.batchId} onChange={(e) => set(r.key, { batchId: e.target.value })} className="rounded-control border border-line px-2 py-1 text-[0.95rem]" aria-label="Batch">
                    <option value="">Earliest expiry first</option>{it.lots.filter((l) => l.qty > 0).map((l) => <option key={l.batch_id} value={l.batch_id}>{l.batch_no} exp {l.expiry_date ?? "—"} ({l.qty} left)</option>)}</select> : null}
                </div> : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="text-ink-soft">Search above to add medicines. Expired and blocked batches are never offered.</p>}

      <datalist id="sub-reasons">{SUB_REASONS.map((s) => <option key={s} value={s} />)}</datalist>
      {needsExt ? (
        <fieldset className="rounded-panel border border-warn/40 p-4">
          <legend className="px-1 text-[0.95rem] font-medium">Outside prescription</legend>
          {!canSellRx ? <p className="text-[0.95rem] text-alert">Only a verified pharmacist can sell prescription medicines.</p> : (
            <div className="grid gap-3 sm:grid-cols-4">
              <label className="sm:col-span-2"><span className="block text-sm text-ink-soft">Prescriber</span><input required value={ext.prescriber_name} onChange={(e) => setExt({ ...ext, prescriber_name: e.target.value })} className={field} placeholder="Dr. …" /></label>
              <label><span className="block text-sm text-ink-soft">NMC no.</span><input value={ext.prescriber_reg_no} onChange={(e) => setExt({ ...ext, prescriber_reg_no: e.target.value })} className={field} /></label>
              <label><span className="block text-sm text-ink-soft">Date</span><input type="date" value={ext.rx_date} onChange={(e) => setExt({ ...ext, rx_date: e.target.value })} className={field} /></label>
              <label className="sm:col-span-4"><span className="block text-sm text-ink-soft">Hospital or clinic</span><input value={ext.facility} onChange={(e) => setExt({ ...ext, facility: e.target.value })} className={field} /></label>
            </div>
          )}
        </fieldset>
      ) : null}

      </div>

      {/* The pay panel: who it's for, the total (the counter's one big number), how it's paid. */}
      <aside aria-label="Customer and payment" className="space-y-5 rounded-panel border border-line bg-canvas p-4 lg:sticky lg:top-20">
        <fieldset className="space-y-3">
          <legend className="mb-1.5 text-lg font-semibold">Customer</legend>
          {patient ? (
            <div className="flex items-center justify-between rounded-control border border-line px-3 py-2"><span>{patient.full_name} <span className="text-[0.95rem] text-ink-soft">{patient.mrn}, {patient.age}{patient.phone ? `, ${patient.phone}` : ""}</span></span>
              {!prefill && !hold ? <button type="button" onClick={() => setPatient(null)} className="text-[0.95rem] text-pine">Change</button> : null}</div>
          ) : (
            <>
              <div className="relative">
                <input value={pq} onChange={(e) => searchPatient(e.target.value)} className={field} placeholder="Link a patient: name, phone or MRN (optional)" />
                {pres.length ? <ul className="absolute z-10 mt-1 w-full divide-y divide-line rounded-panel border border-line bg-surface shadow-sm">{pres.map((x) => (
                  <li key={x.id}><button type="button" onClick={() => { setPatient(x); setPres([]); setPq(""); }} className="w-full px-3 py-2 text-left hover:bg-pine/5">{x.full_name} <span className="text-[0.95rem] text-ink-soft">{x.mrn} · {x.phone ?? ""}</span></button></li>))}</ul> : null}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input value={name} onChange={(e) => setName(e.target.value)} className={field} placeholder="Name (optional)" />
                <input value={phone} onChange={(e) => setPhone(e.target.value)} onBlur={() => setPhone(normalizePhone(phone))} type="tel" inputMode="tel" aria-label="Customer phone"
                  aria-invalid={Boolean(phoneProblem(normalizePhone(phone)))} className={cn(field, phoneProblem(normalizePhone(phone)) && "border-alert")} placeholder="Phone (optional)" />
              </div>
              {phoneProblem(normalizePhone(phone)) ? <p role="alert" className="text-[0.95rem] text-alert">{phoneProblem(normalizePhone(phone))}</p> : null}
            </>
          )}
        </fieldset>
        <fieldset className="space-y-3 border-t border-line pt-4">
          <legend className="sr-only">Payment</legend>
          <div className="flex items-end justify-between gap-3">
            <span className="text-ink-soft">Total<span className="block text-sm text-ink-soft">{rows.length ? `${rows.length} line${rows.length === 1 ? "" : "s"}, estimate` : "no lines yet"}</span></span>
            <span className="text-[2.6rem] font-semibold leading-none tracking-[-0.01em] tabular-nums" data-testid="counter-total">{npr(total)}</span>
          </div>
          {fromAdvance > 0 ? <div className="flex items-baseline justify-between text-[0.95rem]"><span className="text-ink-soft">From the advance ({npr(held)} held)</span><span className="tabular-nums">− {npr(fromAdvance)}; take {npr(toTake)}</span></div> : null}
          <div className="grid grid-cols-2 gap-3">
            <label><span className="block text-sm text-ink-soft">Cash</span><input ref={cashRef} type="number" min={0} step="0.01" value={cash} onChange={(e) => setCash(e.target.value)} aria-label="Cash" className={field} /></label>
            <label><span className="block text-sm text-ink-soft">Online</span><input type="number" min={0} step="0.01" value={online} onChange={(e) => setOnline(e.target.value)} className={field} /></label>
            <label className="col-span-2"><span className="block text-sm text-ink-soft">Online paid by</span><select value={channel} onChange={(e) => setChannel(e.target.value)} disabled={!Number(online)} className={field}><option value="">—</option>{CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          </div>
          <div className="flex flex-wrap gap-2 text-[0.95rem]">
            <button type="button" onClick={() => { setCash(String(toTake)); setOnline(""); }} className="rounded-control border border-line px-2 py-1">All cash</button>
            <button type="button" onClick={() => { setOnline(String(toTake)); setCash(""); }} className="rounded-control border border-line px-2 py-1">All online</button>
            <span className="self-center text-ink-soft">{paid < toTake ? (allowCredit && patient ? `${npr(toTake - paid)} will be left as due` : `${npr(toTake - paid)} still to take`) : paid > toTake ? `Change ${npr(paid - toTake)}: enter only the amount to take` : "Paid in full"}</span>
          </div>
        </fieldset>

        {err ? <p role="alert" className="rounded-control bg-alert-tint px-3 py-2 text-[0.95rem] text-alert">{err}</p> : null}
        <Button type="submit" className="w-full text-base" disabled={pending || !rows.length}>{pending ? "Issuing…" : hold ? "Issue bill and hand over" : "Issue bill"}</Button>
        {!hold ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4 text-[0.95rem]">
            <span className="w-full text-ink-soft">Or keep it aside for a customer</span>
            <select value={holdHours} onChange={(e) => setHoldHours(e.target.value)} aria-label="Hold for" className="flex-1 rounded-control border border-line-strong bg-surface px-2 py-2">
              {HOLD_HOURS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <Button type="button" tone="secondary" className="whitespace-nowrap" disabled={pending || !rows.length} onClick={holdForLater}>Hold for later</Button>
          </div>
        ) : null}
      </aside>
    </form>
  );
}
