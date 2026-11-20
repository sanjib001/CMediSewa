"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveItem } from "@/app/actions/inventory";
import type { ItemDetail } from "@/lib/inventory/data";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

const field = "w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-ink placeholder:text-ink-faint";
const lbl = "mb-1 block text-sm font-medium";
const FORMS = ["tablet", "capsule", "syrup", "suspension", "injection", "infusion", "ointment", "cream", "gel", "drops", "inhaler", "powder", "sachet", "suppository", "lotion", "other"];
const ROUTES = ["oral", "IV", "IM", "SC", "topical", "ophthalmic", "otic", "nasal", "inhalation", "rectal", "vaginal"];
const STRENGTH = ["mg", "g", "mcg", "ml", "IU", "%", "mg/ml", "mg/5ml", "mcg/ml", "units"];
type U = { id?: string; name: string; factor: string; is_base: boolean };

// Common Nepali pharmacy packs, as a starting point the user edits.
const PRESETS: Record<string, U[]> = {
  "Tablets: strip of 10, box of 10 strips": [{ name: "tab", factor: "1", is_base: true }, { name: "strip", factor: "10", is_base: false }, { name: "box", factor: "100", is_base: false }],
  "Capsules: strip of 10": [{ name: "cap", factor: "1", is_base: true }, { name: "strip", factor: "10", is_base: false }],
  "Bottle (syrup, drops)": [{ name: "bottle", factor: "1", is_base: true }],
  "Vial / ampoule, box of 10": [{ name: "vial", factor: "1", is_base: true }, { name: "box", factor: "10", is_base: false }],
  "Pieces": [{ name: "pcs", factor: "1", is_base: true }],
};

export function ItemForm({ item, lists }: { item: ItemDetail | null; lists: { generics: string[]; categories: string[]; manufacturers: string[] } }) {
  const router = useRouter();
  const [type, setType] = useState(item?.item_type ?? "medicine");
  const [units, setUnits] = useState<U[]>(item?.units.length
    ? item.units.map((u) => ({ id: u.id, name: u.name, factor: String(u.factor_to_base), is_base: u.is_base }))
    : PRESETS["Tablets: strip of 10, box of 10 strips"]!);
  const [barcodes, setBarcodes] = useState(item?.barcodes ?? []);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const locked = Boolean(item?.hasStock);
  const base = units.find((u) => u.is_base)?.name || "base unit";

  return (
    <form className="space-y-6" onSubmit={(e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
      setError(null);
      start(async () => {
        const r = await saveItem(item?.id ?? null, {
          ...f, item_type: type, is_active: f.is_active === "on", allow_loose_sale: f.allow_loose_sale === "on", is_returnable_to_vendor: f.is_returnable_to_vendor === "on",
          units: units.map((u) => ({ id: u.id, name: u.name, factor: u.factor, is_base: u.is_base })), barcodes: barcodes.filter((b) => b.barcode.trim()),
        });
        if (r.ok) { router.push("/admin/medicines"); router.refresh(); } else setError(r.error);
      });
    }}>
      <datalist id="dl-generics">{lists.generics.map((g) => <option key={g} value={g} />)}</datalist>
      <datalist id="dl-categories">{lists.categories.map((g) => <option key={g} value={g} />)}</datalist>
      <datalist id="dl-manufacturers">{lists.manufacturers.map((g) => <option key={g} value={g} />)}</datalist>

      <section className="grid gap-3 rounded-panel border border-line bg-surface p-5 sm:grid-cols-3">
        <label className="block"><span className={lbl}>Kind</span>
          <select value={type} onChange={(e) => setType(e.target.value)} disabled={locked} className={field}>
            {[["medicine", "Medicine"], ["consumable", "Consumable"], ["surgical", "Surgical item"], ["lab_reagent", "Lab reagent"], ["other", "Other"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></label>
        <label className="block sm:col-span-2"><span className={lbl}>Name on the shelf (brand)</span><input name="name" required defaultValue={item?.name} placeholder="e.g. Cetamol 500" className={field} /></label>
        <label className="block"><span className={lbl}>Category</span><input name="category" list="dl-categories" defaultValue={item?.category ?? ""} placeholder="e.g. Analgesics" className={field} /></label>
        <label className="block"><span className={lbl}>Manufacturer</span><input name="manufacturer" list="dl-manufacturers" defaultValue={item?.manufacturer ?? ""} className={field} /></label>
        <label className="block"><span className={lbl}>SKU / code (optional)</span><input name="sku" defaultValue={item?.sku ?? ""} className={field} /></label>
      </section>

      {type === "medicine" ? (
        <section className="grid gap-3 rounded-panel border border-line bg-surface p-5 sm:grid-cols-4">
          <h2 className="font-semibold sm:col-span-4">Medicine</h2>
          <label className="block sm:col-span-2"><span className={lbl}>Generic name</span><input name="generic" list="dl-generics" defaultValue={item?.generic ?? ""} placeholder="e.g. Paracetamol" className={field} /></label>
          <label className="block"><span className={lbl}>Strength</span><input name="strength_value" inputMode="decimal" defaultValue={item?.strength_value ?? ""} placeholder="500" className={field} /></label>
          <label className="block"><span className={lbl}>Unit</span>
            <select name="strength_unit" defaultValue={item?.strength_unit ?? "mg"} className={field}>{STRENGTH.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className="block sm:col-span-2"><span className={lbl}>or strength as text (combinations)</span><input name="strength_text" defaultValue={item?.strength_text ?? ""} placeholder="e.g. 500 mg + 65 mg" className={field} /></label>
          <label className="block"><span className={lbl}>Form</span>
            <select name="dosage_form" defaultValue={item?.dosage_form ?? "tablet"} className={field}>{FORMS.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className="block"><span className={lbl}>Route</span>
            <select name="route" defaultValue={item?.route ?? "oral"} className={field}>{ROUTES.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className="block sm:col-span-2"><span className={lbl}>Sale rule</span>
            <select name="schedule_class" defaultValue={item?.schedule_class ?? "prescription_only"} className={field}>
              <option value="otc">Over the counter</option><option value="prescription_only">Prescription only</option>
              <option value="controlled">Controlled (blocked from sale for now)</option><option value="narcotic">Narcotic (blocked from sale for now)</option>
            </select></label>
          <label className="block"><span className={lbl}>DDA registration no.</span><input name="dda_registration_no" defaultValue={item?.dda_registration_no ?? ""} className={field} /></label>
          <label className="block"><span className={lbl}>Pack as printed</span><input name="pack_description" defaultValue={item?.pack_description ?? ""} placeholder="10×10 tablets" className={field} /></label>
        </section>
      ) : null}

      <section className="rounded-panel border border-line bg-surface p-5">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">Units</h2>
          {!locked ? (
            <select aria-label="Start from a common pack" className="rounded-control border border-line-strong px-2 py-1 text-sm" value="" onChange={(e) => { if (e.target.value) setUnits(PRESETS[e.target.value]!.map((u) => ({ ...u }))); }}>
              <option value="">Start from a common pack…</option>{Object.keys(PRESETS).map((k) => <option key={k}>{k}</option>)}
            </select>
          ) : <span className="text-sm text-ink-faint">Sizes are fixed once the item has stock; you can add units.</span>}
        </div>
        <p className="mb-3 text-sm text-ink-soft">The <strong>base unit</strong> is the smallest unit you ever sell (a tablet if you sell loose tablets). All stock is counted in it.</p>
        <div className="space-y-2">
          {units.map((u, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input value={u.name} onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="strip" aria-label="Unit name" className={cn(field, "w-32")} />
              {u.is_base ? <span className="text-sm text-ink-soft">base unit (1)</span> : (
                <span className="flex items-center gap-2 text-sm">=
                  <input value={u.factor} disabled={locked && Boolean(u.id)} onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, factor: e.target.value } : x)))} inputMode="decimal" aria-label="How many base units" className={cn(field, "w-24")} />
                  {base}</span>
              )}
              <label className="flex items-center gap-1 text-sm"><input type="radio" name="base" checked={u.is_base} disabled={locked}
                onChange={() => setUnits(units.map((x, j) => ({ ...x, is_base: j === i, factor: j === i ? "1" : x.factor })))} />base</label>
              {!u.is_base && !(locked && u.id) ? <button type="button" aria-label="Remove unit" className="px-2 text-ink-faint hover:text-alert" onClick={() => setUnits(units.filter((_, j) => j !== i))}>×</button> : null}
            </div>
          ))}
        </div>
        <button type="button" className="mt-2 text-sm text-pine hover:underline" onClick={() => setUnits([...units, { name: "", factor: "", is_base: false }])}>Add unit</button>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="block"><span className={lbl}>Usually bought in</span>
            <select name="default_purchase_unit" defaultValue={item?.default_purchase_unit ?? units.at(-1)?.name} className={field}>{units.filter((u) => u.name).map((u) => <option key={u.name}>{u.name}</option>)}</select></label>
          <label className="block"><span className={lbl}>Usually sold in</span>
            <select name="default_sale_unit" defaultValue={item?.default_sale_unit ?? units[1]?.name ?? units[0]?.name} className={field}>{units.filter((u) => u.name).map((u) => <option key={u.name}>{u.name}</option>)}</select></label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="allow_loose_sale" defaultChecked={item?.allow_loose_sale ?? true} />Can be sold loose</label>
        </div>
      </section>

      <section className="rounded-panel border border-line bg-surface p-5">
        <h2 className="mb-3 font-semibold">Barcodes</h2>
        <div className="space-y-2">
          {barcodes.map((b, i) => (
            <div key={i} className="flex gap-2">
              <input value={b.barcode} onChange={(e) => setBarcodes(barcodes.map((x, j) => (j === i ? { ...x, barcode: e.target.value } : x)))} placeholder="Scan or type" aria-label="Barcode" className={cn(field, "max-w-xs")} />
              <select value={b.unit} onChange={(e) => setBarcodes(barcodes.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} aria-label="Unit the barcode is on" className={cn(field, "w-32")}>
                {units.filter((u) => u.name).map((u) => <option key={u.name}>{u.name}</option>)}</select>
              <button type="button" aria-label="Remove barcode" className="px-2 text-ink-faint hover:text-alert" onClick={() => setBarcodes(barcodes.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
        <button type="button" className="mt-2 text-sm text-pine hover:underline" onClick={() => setBarcodes([...barcodes, { barcode: "", unit: units[1]?.name ?? units[0]?.name ?? "" }])}>Add barcode</button>
      </section>

      <section className="grid gap-3 rounded-panel border border-line bg-surface p-5 sm:grid-cols-4">
        <h2 className="font-semibold sm:col-span-4">Stock levels <span className="font-normal text-ink-faint">(in {base})</span></h2>
        <label className="block"><span className={lbl}>Critical below</span><input name="min_stock_level" inputMode="decimal" defaultValue={item?.min_stock_level ?? ""} className={field} /></label>
        <label className="block"><span className={lbl}>Reorder at</span><input name="reorder_level" inputMode="decimal" defaultValue={item?.reorder_level ?? ""} className={field} /></label>
        <label className="block"><span className={lbl}>Reorder quantity</span><input name="reorder_qty" inputMode="decimal" defaultValue={item?.reorder_qty ?? ""} className={field} /></label>
        <label className="block"><span className={lbl}>Maximum</span><input name="max_stock_level" inputMode="decimal" defaultValue={item?.max_stock_level ?? ""} className={field} /></label>
        <label className="block"><span className={lbl}>Storage</span>
          <select name="storage_condition" defaultValue={item?.storage_condition ?? "room"} className={field}>
            <option value="room">Room temperature</option><option value="cool_2_8">Fridge 2–8 °C</option><option value="frozen">Frozen</option><option value="protect_light">Protect from light</option></select></label>
        <label className="block"><span className={lbl}>VAT</span>
          <select name="tax_category" defaultValue={item?.tax_category ?? "exempt"} className={field}><option value="exempt">Exempt</option><option value="vat13">13%</option></select></label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="is_returnable_to_vendor" defaultChecked={item?.is_returnable_to_vendor ?? true} />Returnable to vendor</label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="is_active" defaultChecked={item?.is_active ?? true} />In use</label>
      </section>

      {error ? <p role="alert" className="rounded-control bg-alert-tint px-3 py-2 text-sm text-alert">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : item ? "Save item" : "Add item"}</Button>
        <Button type="button" tone="secondary" onClick={() => router.push("/admin/medicines")}>Cancel</Button>
      </div>
    </form>
  );
}
