"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveItem } from "@/app/actions/inventory";
import type { ItemDetail } from "@/lib/inventory/data";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

const field = "w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-ink placeholder:text-ink-faint";
const lbl = "mb-1 block text-sm font-medium";
const hint = "mt-1 block text-xs text-ink-faint";
const FORMS = ["tablet", "capsule", "syrup", "suspension", "injection", "infusion", "ointment", "cream", "gel", "drops", "inhaler", "powder", "sachet", "suppository", "lotion", "other"];
const ROUTES = ["oral", "IV", "IM", "SC", "topical", "ophthalmic", "otic", "nasal", "inhalation", "rectal", "vaginal"];
const STRENGTH = ["mg", "g", "mcg", "ml", "IU", "%", "mg/ml", "mg/5ml", "mcg/ml", "units"];
type U = { id?: string; name: string; factor: string; is_base: boolean };

// Common Nepali pharmacy packs. Most medicines are one of these; "Change pack sizes" covers the rest.
const PRESETS: Record<string, U[]> = {
  "Tablets: strip of 10, box of 10 strips": [{ name: "tab", factor: "1", is_base: true }, { name: "strip", factor: "10", is_base: false }, { name: "box", factor: "100", is_base: false }],
  "Capsules: strip of 10, box of 10 strips": [{ name: "cap", factor: "1", is_base: true }, { name: "strip", factor: "10", is_base: false }, { name: "box", factor: "100", is_base: false }],
  "Bottle (syrup, drops, cream)": [{ name: "bottle", factor: "1", is_base: true }],
  "Vial / ampoule, box of 10": [{ name: "vial", factor: "1", is_base: true }, { name: "box", factor: "10", is_base: false }],
  "Pieces": [{ name: "pcs", factor: "1", is_base: true }],
};
const sameUnits = (a: U[], b: U[]) => a.length === b.length && a.every((u, i) => u.name === b[i]!.name && Number(u.factor) === Number(b[i]!.factor) && u.is_base === b[i]!.is_base);
/** "1 box = 10 strip = 100 tab" */
const packSummary = (units: U[]) => {
  const base = units.find((u) => u.is_base);
  const big = [...units].filter((u) => !u.is_base && Number(u.factor) > 0).sort((a, b) => Number(b.factor) - Number(a.factor));
  if (!base) return "";
  if (!big.length) return `Counted in ${base.name}`;
  return `1 ${big[0]!.name} = ${big.slice(1).map((u) => `${Number(big[0]!.factor) / Number(u.factor)} ${u.name} = `).join("")}${Number(big[0]!.factor)} ${base.name}`;
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
  const preset = Object.keys(PRESETS).find((k) => sameUnits(PRESETS[k]!, units)) ?? "";
  const [editUnits, setEditUnits] = useState(!preset);

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

      {/* 1. What it is: the few things every medicine needs */}
      <section className="grid gap-4 rounded-panel border border-line bg-surface p-5 sm:grid-cols-4">
        <div className="sm:col-span-4 flex flex-wrap gap-2" role="radiogroup" aria-label="Kind">
          {([["medicine", "Medicine"], ["consumable", "Other item (gloves, syringes…)"]] as const).map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={v === "medicine" ? type === "medicine" : type !== "medicine"} disabled={locked}
              onClick={() => { setType(v); if (v !== "medicine" && preset.startsWith("Tablets")) setUnits(PRESETS["Pieces"]!.map((u) => ({ ...u }))); }}
              className={cn("rounded-control border px-3 py-1.5 text-sm", (v === "medicine" ? type === "medicine" : type !== "medicine") ? "border-pine bg-pine-tint font-medium text-pine-deep" : "border-line-strong")}>{l}</button>
          ))}
        </div>
        <label className="block sm:col-span-2"><span className={lbl}>Name on the shelf</span><input name="name" required defaultValue={item?.name} placeholder={type === "medicine" ? "e.g. Cetamol 500" : "e.g. Gloves (medium)"} className={field} autoFocus={!item} /></label>
        {type === "medicine" ? (
          <>
            <label className="block sm:col-span-2"><span className={lbl}>Generic name</span><input name="generic" list="dl-generics" defaultValue={item?.generic ?? ""} placeholder="e.g. Paracetamol" className={field} />
              <span className={hint}>Brands with the same generic, strength and form are offered as substitutes.</span></label>
            <label className="block"><span className={lbl}>Strength</span><input name="strength_value" inputMode="decimal" defaultValue={item?.strength_value ?? ""} placeholder="500" className={field} /></label>
            <label className="block"><span className={lbl}>Unit</span>
              <select name="strength_unit" defaultValue={item?.strength_unit ?? "mg"} className={field}>{STRENGTH.map((s) => <option key={s}>{s}</option>)}</select></label>
            <label className="block"><span className={lbl}>Form</span>
              <select name="dosage_form" defaultValue={item?.dosage_form ?? "tablet"} className={field}>{FORMS.map((s) => <option key={s}>{s}</option>)}</select></label>
            <label className="block"><span className={lbl}>Sold</span>
              <select name="schedule_class" defaultValue={item?.schedule_class ?? "prescription_only"} className={field}>
                <option value="prescription_only">Only with a prescription</option><option value="otc">Over the counter</option>
                <option value="controlled">Controlled (not sold for now)</option><option value="narcotic">Narcotic (not sold for now)</option>
              </select></label>
          </>
        ) : null}
      </section>

      {/* 2. How it is packed and when to buy more */}
      <section className="grid gap-4 rounded-panel border border-line bg-surface p-5 sm:grid-cols-2">
        <div>
          <label className="block"><span className={lbl}>Pack</span>
            <select value={editUnits ? "" : preset} disabled={locked} className={field}
              onChange={(e) => { if (e.target.value) { setUnits(PRESETS[e.target.value]!.map((u) => ({ ...u }))); setEditUnits(false); } else setEditUnits(true); }}>
              {Object.keys(PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
              <option value="">Other pack sizes…</option>
            </select></label>
          <p className="mt-1 text-sm text-ink-soft">{packSummary(units)}{locked ? " (fixed now that it has stock)" : ""}</p>
          {!editUnits && !locked ? <button type="button" className="mt-1 text-sm text-pine hover:underline" onClick={() => setEditUnits(true)}>Change pack sizes</button> : null}
        </div>
        <label className="block"><span className={lbl}>Reorder when stock falls to</span>
          <span className="flex items-center gap-2"><input name="reorder_level" inputMode="decimal" defaultValue={item?.reorder_level ?? ""} placeholder="e.g. 200" className={field} /><span className="text-sm text-ink-soft">{base}</span></span>
          <span className={hint}>Optional. It then shows on the Reorder list and in stock alerts.</span></label>

        {editUnits || locked ? (
          <div className="sm:col-span-2 rounded-control border border-line p-4">
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
          </div>
        ) : null}
      </section>

      {/* 3. Everything else, folded away: sensible defaults are used when left alone */}
      <details className="group rounded-panel border border-line bg-surface p-5" open={false}>
        <summary className="cursor-pointer list-none font-semibold [&::-webkit-details-marker]:hidden">
          <span className="text-pine group-open:hidden">More details</span><span className="hidden text-pine group-open:inline">Fewer details</span>
          <span className="ml-2 text-sm font-normal text-ink-faint">category, maker, VAT, storage, barcodes, other levels. Optional.</span>
        </summary>
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          {type !== "medicine" ? (
            <label className="block"><span className={lbl}>Kind</span>
              <select value={type} onChange={(e) => setType(e.target.value)} disabled={locked} className={field}>
                {[["consumable", "Consumable"], ["surgical", "Surgical item"], ["lab_reagent", "Lab reagent"], ["other", "Other"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select></label>
          ) : null}
          <label className="block"><span className={lbl}>Category</span><input name="category" list="dl-categories" defaultValue={item?.category ?? ""} placeholder="e.g. Analgesics" className={field} /></label>
          <label className="block"><span className={lbl}>Manufacturer</span><input name="manufacturer" list="dl-manufacturers" defaultValue={item?.manufacturer ?? ""} className={field} /></label>
          <label className="block"><span className={lbl}>Code (SKU)</span><input name="sku" defaultValue={item?.sku ?? ""} className={field} /></label>
          <label className="block"><span className={lbl}>VAT</span>
            <select name="tax_category" defaultValue={item?.tax_category ?? "exempt"} className={field}><option value="exempt">Exempt</option><option value="vat13">13%</option></select></label>
          {type === "medicine" ? (
            <>
              <label className="block sm:col-span-2"><span className={lbl}>Strength as text (combinations)</span><input name="strength_text" defaultValue={item?.strength_text ?? ""} placeholder="e.g. 500 mg + 65 mg" className={field} /></label>
              <label className="block"><span className={lbl}>Route</span>
                <select name="route" defaultValue={item?.route ?? "oral"} className={field}>{ROUTES.map((s) => <option key={s}>{s}</option>)}</select></label>
              <label className="block"><span className={lbl}>DDA registration no.</span><input name="dda_registration_no" defaultValue={item?.dda_registration_no ?? ""} className={field} /></label>
              <label className="block sm:col-span-2"><span className={lbl}>Pack as printed</span><input name="pack_description" defaultValue={item?.pack_description ?? ""} placeholder="10×10 tablets" className={field} /></label>
            </>
          ) : null}
          <label className="block"><span className={lbl}>Storage</span>
            <select name="storage_condition" defaultValue={item?.storage_condition ?? "room"} className={field}>
              <option value="room">Room temperature</option><option value="cool_2_8">Fridge 2–8 °C</option><option value="frozen">Frozen</option><option value="protect_light">Protect from light</option></select></label>
          <label className="block"><span className={lbl}>Usually bought in</span>
            <select name="default_purchase_unit" defaultValue={item?.default_purchase_unit ?? units.at(-1)?.name} className={field}>{units.filter((u) => u.name).map((u) => <option key={u.name}>{u.name}</option>)}</select></label>
          <label className="block"><span className={lbl}>Usually sold in</span>
            <select name="default_sale_unit" defaultValue={item?.default_sale_unit ?? units[1]?.name ?? units[0]?.name} className={field}>{units.filter((u) => u.name).map((u) => <option key={u.name}>{u.name}</option>)}</select></label>
          <label className="block"><span className={lbl}>Critical below</span><input name="min_stock_level" inputMode="decimal" defaultValue={item?.min_stock_level ?? ""} className={field} /><span className={hint}>in {base}</span></label>
          <label className="block"><span className={lbl}>Buy this much each time</span><input name="reorder_qty" inputMode="decimal" defaultValue={item?.reorder_qty ?? ""} className={field} /><span className={hint}>in {base}</span></label>
          <label className="block"><span className={lbl}>Keep at most</span><input name="max_stock_level" inputMode="decimal" defaultValue={item?.max_stock_level ?? ""} className={field} /><span className={hint}>in {base}</span></label>
          <div className="space-y-2 self-end pb-2 text-sm sm:col-span-4 sm:flex sm:gap-6 sm:space-y-0">
            <label className="flex items-center gap-2"><input type="checkbox" name="allow_loose_sale" defaultChecked={item?.allow_loose_sale ?? true} />Can be sold loose</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="is_returnable_to_vendor" defaultChecked={item?.is_returnable_to_vendor ?? true} />Returnable to vendor</label>
            {!item ? <input type="hidden" name="is_active" value="on" /> : null}
          </div>
          <div className="sm:col-span-4">
            <p className={lbl}>Barcodes <span className="font-normal text-ink-faint">(only if you scan at the counter)</span></p>
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
          </div>
        </div>
      </details>

      {item ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_active" defaultChecked={item.is_active} />In use (untick to stop selling and ordering it)</label> : null}
      {error ? <p role="alert" className="rounded-control bg-alert-tint px-3 py-2 text-sm text-alert">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : item ? "Save" : type === "medicine" ? "Add medicine" : "Add item"}</Button>
        <Button type="button" tone="secondary" onClick={() => router.push("/admin/medicines")}>Cancel</Button>
      </div>
    </form>
  );
}
