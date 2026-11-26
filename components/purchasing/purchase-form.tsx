"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { postPurchase } from "@/app/actions/purchasing";
import { findItems } from "@/app/actions/inventory";
import type { ItemRow } from "@/lib/inventory/data";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

const f = "w-full rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint";
const lbl = "mb-1 block text-sm font-medium";
const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export type PoPrefill = { poId: string; poNo: string; vendorId: string; storeId: string; lines: { po_line_id: string; item: ItemRow; unit_id: string; qty: number; unit_cost: number | null }[] };
type Row = { po_line_id?: string; item: ItemRow; unit_id: string; qty: string; free_qty: string; unit_cost: string; discount_pct: string; tax_rate: number; batch_no: string; expiry_date: string; mrp: string; short_expiry_reason: string };

function Picker({ onPick }: { onPick: (i: ItemRow) => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<ItemRow[]>([]);
  const [looked, setLooked] = useState("");
  useEffect(() => {
    if (q.trim().length < 2) return;
    let live = true;
    const t = setTimeout(() => findItems(q).then((r) => { if (live) { setList(r); setLooked(q.trim()); } }), 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  return (
    <div className="relative max-w-md">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add an item: type its name, generic or code" aria-label="Add an item" className={f} />
      {q.trim().length >= 2 && looked === q.trim() && !list.length ? (
        <p className="mt-1 text-sm text-ink-soft">No item matches &quot;{q.trim()}&quot;. <a href="/admin/medicines/new" target="_blank" rel="noreferrer" className="text-pine underline">Add it in Medicines</a> (opens a new tab), then type it again here.</p>
      ) : null}
      {q.trim().length >= 2 && list.length ? (
        <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-control border border-line bg-surface shadow-lg">
          {list.map((i) => <li key={i.id}><button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-sunken" onClick={() => { onPick(i); setQ(""); setList([]); }}>
            {i.name} <span className="text-ink-faint">{[i.generic, i.strength].filter(Boolean).join(" ")}</span></button></li>)}
        </ul>
      ) : null}
    </div>
  );
}

/** Enter a vendor bill (W-41). Totals shown here are an estimate; the database computes the
 *  real ones from the lines. Each line becomes a new lot in the receiving store. */
export function PurchaseForm({ vendors, stores, defaultVendor, today, po }: { vendors: { id: string; name: string }[]; stores: { id: string; name: string }[]; defaultVendor?: string; today: string; po?: PoPrefill | null }) {
  const router = useRouter();
  const [vendorId, setVendorId] = useState(po?.vendorId ?? defaultVendor ?? vendors[0]?.id ?? "");
  const [storeId, setStoreId] = useState(po?.storeId ?? stores[0]?.id ?? "");
  const [billNo, setBillNo] = useState("");
  const [billDate, setBillDate] = useState(today);
  const [rows, setRows] = useState<Row[]>(po ? po.lines.map((l) => ({
    po_line_id: l.po_line_id, item: l.item, unit_id: l.unit_id, qty: String(l.qty), free_qty: "", unit_cost: l.unit_cost === null ? "" : String(l.unit_cost), discount_pct: "", tax_rate: 0,
    batch_no: "", expiry_date: "", mrp: "", short_expiry_reason: "",
  })) : []);
  const [billDiscount, setBillDiscount] = useState("");
  const [cash, setCash] = useState("");
  const [online, setOnline] = useState("");
  const [channel, setChannel] = useState("bank_transfer");
  const [error, setError] = useState<string | null>(null);
  const [badLine, setBadLine] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const key = useRef(crypto.randomUUID());
  const set = (i: number, p: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));

  // The same arithmetic and rounding as post_purchase_invoice, so "Pay all" matches the bill to the paisa.
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const calc = rows.map((r) => {
    const gross = r2((Number(r.qty) || 0) * (Number(r.unit_cost) || 0));
    const net = gross - r2(gross * (Number(r.discount_pct) || 0) / 100);
    return { gross, net, tax: r2(net * r.tax_rate / 100) };
  });
  const net = r2(calc.reduce((s, c) => s + c.net, 0));
  const bd = r2(Number(billDiscount) || 0);
  const taxLines = r2(calc.reduce((s, c) => s + c.tax, 0));
  const tax = bd > 0 && net > 0 ? r2(taxLines * (net - bd) / net) : taxLines;
  const total = r2(net - bd + tax);
  const paidNow = Math.round(((Number(cash) || 0) + (Number(online) || 0)) * 100) / 100;
  const credit = Math.max(0, Math.round((total - paidNow) * 100) / 100);
  const over = paidNow > total + 0.004;

  return (
    <div className="space-y-6">
      {po ? <p className="rounded-control bg-pine-tint px-3 py-2 text-sm text-pine-deep">Receiving order {po.poNo}: the lines below are what&apos;s still to come. Change quantities to what actually arrived and remove anything that didn&apos;t.</p> : null}
      <section className="grid gap-3 rounded-panel border border-line bg-surface p-5 sm:grid-cols-4">
        <label className="block sm:col-span-2"><span className={lbl}>Vendor</span>
          <select value={vendorId} disabled={Boolean(po)} onChange={(e) => setVendorId(e.target.value)} className={cn(f, "py-2")}>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
        <label className="block"><span className={lbl}>Vendor&apos;s bill no.</span><input value={billNo} onChange={(e) => setBillNo(e.target.value)} required className={cn(f, "py-2")} /></label>
        <label className="block"><span className={lbl}>Bill date</span><input type="date" max={today} value={billDate} onChange={(e) => setBillDate(e.target.value)} className={cn(f, "py-2")} /></label>
        <label className="block sm:col-span-2"><span className={lbl}>Receive into</span>
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={cn(f, "py-2")}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      </section>

      <section className="space-y-3 rounded-panel border border-line bg-surface p-5">
        <h2 className="font-semibold">Items on the bill</h2>
        {rows.length ? (
          <div className="hidden grid-cols-[1.8fr_0.9fr_0.6fr_0.6fr_0.8fr_0.6fr_0.6fr_0.9fr_1fr_0.8fr_auto] gap-2 px-1 text-xs text-ink-faint xl:grid">
            <span>Item</span><span>Unit</span><span>Qty</span><span>Free</span><span>Rate</span><span>Disc %</span><span>VAT</span><span>Batch</span><span>Expiry</span><span>MRP</span><span />
          </div>
        ) : null}
        {rows.map((r, i) => (
          <div key={i} className={cn("grid grid-cols-2 gap-2 rounded-control border p-2 xl:grid-cols-[1.8fr_0.9fr_0.6fr_0.6fr_0.8fr_0.6fr_0.6fr_0.9fr_1fr_0.8fr_auto] xl:border-0 xl:p-0", badLine === i + 1 ? "border-alert" : "border-line")}>
            <span className="col-span-2 self-center truncate text-sm font-medium xl:col-span-1">{r.item.name}</span>
            <select value={r.unit_id} onChange={(e) => set(i, { unit_id: e.target.value })} aria-label="Unit" className={f}>{r.item.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
            <input value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} inputMode="decimal" placeholder="Qty" aria-label="Quantity" className={f} />
            <input value={r.free_qty} onChange={(e) => set(i, { free_qty: e.target.value })} inputMode="decimal" placeholder="0" aria-label="Free quantity" className={f} />
            <input value={r.unit_cost} onChange={(e) => set(i, { unit_cost: e.target.value })} inputMode="decimal" placeholder="Rate" aria-label="Rate per unit" className={f} />
            <input value={r.discount_pct} onChange={(e) => set(i, { discount_pct: e.target.value })} inputMode="decimal" placeholder="0" aria-label="Discount percent" className={f} />
            <select value={r.tax_rate} onChange={(e) => set(i, { tax_rate: Number(e.target.value) })} aria-label="VAT" className={f}><option value={0}>0%</option><option value={13}>13%</option></select>
            <input value={r.batch_no} onChange={(e) => set(i, { batch_no: e.target.value.toUpperCase() })} placeholder="Batch" aria-label="Batch number" className={f} />
            <input value={r.expiry_date} onChange={(e) => set(i, { expiry_date: e.target.value })} type="date" aria-label="Expiry date" className={f} />
            <input value={r.mrp} onChange={(e) => set(i, { mrp: e.target.value })} inputMode="decimal" placeholder="MRP" aria-label="MRP per unit" className={f} />
            <button type="button" aria-label="Remove line" className="px-2 text-ink-faint hover:text-alert" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>
            {badLine === i + 1 && error?.includes("shelf life") ? (
              <input value={r.short_expiry_reason} onChange={(e) => set(i, { short_expiry_reason: e.target.value })} placeholder="Why accept a short expiry?" className={cn(f, "col-span-2 xl:col-span-11")} />
            ) : null}
          </div>
        ))}
        <Picker onPick={(it) => setRows([...rows, {
          item: it, unit_id: (it.units.find((u) => u.can_purchase && !u.is_base) ?? it.units[0])!.id, qty: "", free_qty: "", unit_cost: "", discount_pct: "", tax_rate: 0,
          batch_no: "", expiry_date: "", mrp: "", short_expiry_reason: "",
        }])} />
      </section>

      <section className="grid gap-6 rounded-panel border border-line bg-surface p-5 md:grid-cols-2">
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className={lbl}>Bill discount (Rs.)</span><input value={billDiscount} onChange={(e) => setBillDiscount(e.target.value)} inputMode="decimal" className={cn(f, "py-2")} /></label>
          <span />
          <p className="col-span-2 text-sm font-medium">Paying the vendor now? <span className="font-normal text-ink-soft">Leave both blank to keep the whole bill on credit.</span></p>
          <label className="block"><span className={lbl}>Cash now (Rs.)</span><input value={cash} onChange={(e) => setCash(e.target.value)} inputMode="decimal" placeholder="0" aria-label="Cash paid now" className={cn(f, "py-2")} /></label>
          <label className="block"><span className={lbl}>Online now (Rs.)</span><input value={online} onChange={(e) => setOnline(e.target.value)} inputMode="decimal" placeholder="0" aria-label="Online paid now" className={cn(f, "py-2")} /></label>
          <label className={cn("block", Number(online) > 0 ? "" : "opacity-60")}><span className={lbl}>Online via</span>
            <select value={channel} onChange={(e) => setChannel(e.target.value)} disabled={!(Number(online) > 0)} aria-label="Online via" className={cn(f, "py-2")}><option value="bank_transfer">Bank transfer</option><option value="esewa">eSewa</option><option value="khalti">Khalti</option><option value="fonepay">Fonepay</option><option value="card">Card</option><option value="other">Other</option></select></label>
          <div className="col-span-2 flex flex-wrap gap-2 text-sm">
            <button type="button" disabled={!total} onClick={() => { setCash(String(total)); setOnline(""); }} className="rounded-control border border-line px-2 py-1 disabled:opacity-50">Pay all in cash</button>
            <button type="button" disabled={!total} onClick={() => { setOnline(String(total)); setCash(""); }} className="rounded-control border border-line px-2 py-1 disabled:opacity-50">Pay all online</button>
            <button type="button" onClick={() => { setCash(""); setOnline(""); }} className="rounded-control border border-line px-2 py-1">All on credit</button>
          </div>
        </div>
        <dl className="grid grid-cols-[1fr_auto] content-start gap-y-1.5 text-[0.95rem]">
          <dt className="text-ink-soft">Items after discounts</dt><dd className="text-right tabular-nums">{npr(net)}</dd>
          {bd ? <><dt className="text-ink-soft">Bill discount</dt><dd className="text-right tabular-nums">− {npr(bd)}</dd></> : null}
          {tax ? <><dt className="text-ink-soft">VAT</dt><dd className="text-right tabular-nums">{npr(tax)}</dd></> : null}
          <dt className="border-t border-line pt-1.5 font-semibold">Bill total</dt><dd className="border-t border-line pt-1.5 text-right font-semibold tabular-nums">{npr(total)}</dd>
          {Number(cash) > 0 ? <><dt className="text-ink-soft">Paid now in cash</dt><dd className="text-right tabular-nums">− {npr(Number(cash))}</dd></> : null}
          {Number(online) > 0 ? <><dt className="text-ink-soft">Paid now online</dt><dd className="text-right tabular-nums">− {npr(Number(online))}</dd></> : null}
          <dt className="font-medium">On credit (you owe)</dt><dd className="text-right font-medium tabular-nums">{npr(credit)}</dd>
          {over ? <dd className="col-span-2 text-sm text-alert">That&apos;s more than the bill total. Enter only what you pay for this bill (extra payments go in Vendors → Pay this vendor).</dd> : null}
        </dl>
      </section>

      {error ? <p role="alert" className="rounded-control bg-alert-tint px-3 py-2 text-sm text-alert">{error}</p> : null}
      <Button type="button" disabled={pending} onClick={() => {
        setError(null); setBadLine(null);
        const missing = !billNo.trim() ? "Enter the vendor's bill number (top of the form)."
          : !rows.length ? "Add at least one item: type its name in \"Add an item\"."
          : null;
        if (missing) { setError(missing); return; }
        if (over) { setError("You've entered more paid than the bill total. Enter only what you pay for this bill."); return; }
        const n = rows.findIndex((r) => !(Number(r.qty) > 0) || r.unit_cost === "" || (r.item.item_type === "medicine" && (!r.batch_no.trim() || !r.expiry_date)));
        if (n >= 0) {
          const r = rows[n]!;
          setBadLine(n + 1);
          setError(`Line ${n + 1} (${r.item.name}): ${!(Number(r.qty) > 0) ? "enter the quantity" : r.unit_cost === "" ? "enter the rate" : !r.batch_no.trim() ? "enter the batch number" : "enter the expiry date"}.`);
          return;
        }
        if (!window.confirm(`Post bill ${billNo} for about ${npr(total)}${paidNow ? `, paying ${npr(paidNow)} now` : ", all on credit"}? Stock is received now and the bill can only be voided while nothing from it has been used.`)) return;
        start(async () => {
          setError(null); setBadLine(null);
          const r = await postPurchase({
            idempotencyKey: key.current, vendorId, billNo, billDate, storeId, billDiscount: bd, cash: Number(cash) || 0, online: Number(online) || 0, channel,
            lines: rows.map((x) => ({ po_line_id: x.po_line_id ?? null, item_id: x.item.id, unit_id: x.unit_id, qty: x.qty, free_qty: x.free_qty || 0, unit_cost: x.unit_cost || 0, discount_pct: x.discount_pct || 0,
              tax_rate: x.tax_rate, batch_no: x.batch_no, expiry_date: x.expiry_date, mrp: x.mrp, short_expiry_reason: x.short_expiry_reason })),
          });
          if (r.ok) { router.push(`/admin/purchases/${r.id}`); router.refresh(); }
          else { setError(r.error); const m = /line (\d+)/.exec(r.error); setBadLine(m ? Number(m[1]) : null); }
        });
      }}>{pending ? "Posting…" : "Post bill and receive stock"}</Button>
    </div>
  );
}
