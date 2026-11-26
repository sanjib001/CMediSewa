import Link from "next/link";
import { redirect } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { counterServices, counterStock, counterStores, dispensingQueue, heldRxItems, holdForCollection, listHolds, stockStores, todaysBills } from "@/lib/pharmacy/data";
import { getOpenCount, listItems, packText, stockInStore } from "@/lib/inventory/data";
import { CountSheet, StartCount } from "@/components/inventory/count-sheet";
import { getAlerts } from "@/lib/inventory/data";
import { ageText, type PatientLite } from "@/lib/desk/data";
import { serviceClient } from "@/lib/supabase/service";
import { CounterSale, type HoldStart, type RxPrefill } from "@/components/pharmacy/counter";
import { ReleaseHold } from "@/components/pharmacy/holds";
import { AllergyBanner, PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { LiveRefresh } from "@/components/notify/live-refresh";
import { drName } from "@/lib/doctor-name";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pharmacy" };

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const UUID = /^[0-9a-f-]{36}$/;
const ALERT_TEXT = { expired: "Expired", blocked: "Blocked", near_expiry: "Near expiry", critical_stock: "Very low", low_stock: "Low stock" } as const;
type Tab = "dispense" | "sale" | "holds" | "bills" | "stock";
const HOLD_STATUS = { held: "Held", collected: "Collected", released: "Released", expired: "Ran out of time" } as const;
const when = (s: string) => new Date(s).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" });

// The pharmacy counter (W-14): the dispensing queue for pharmacists (C7: Rx items and
// allergies only), the sale screen, and recent bills. Tabs follow the keys held (D-57).
export default async function PharmacyDesk({ searchParams }: { searchParams: Promise<{ tab?: string; store?: string; rx?: string; q?: string; hold?: string }> }) {
  const ctx = await requireTenant({ operation: "pharmacy.counter", next: "/employee/pharmacy" });
  if (!["pharmacy_sell", "dispense_prescription", "view_stock"].some((k) => ctx.permissions.has(k))) redirect("/employee");
  const sp = await searchParams;
  const canSell = ctx.permissions.has("pharmacy_sell"), canDispense = ctx.permissions.has("dispense_prescription");
  const tabs: [Tab, string][] = [];
  if (canDispense) tabs.push(["dispense", "Dispense"]);
  if (canSell) tabs.push(["sale", "Sale"], ["holds", "Holds"], ["bills", "Bills"]);
  if (ctx.permissions.has("view_stock")) tabs.push(["stock", "Stock"]);
  const tab: Tab = (sp.rx || sp.hold) && canSell ? "sale" : tabs.find(([t]) => t === sp.tab)?.[0] ?? tabs[0]?.[0] ?? "bills";
  const stores = await counterStores(ctx.tenantId, ctx.memberId);
  const store = stores.find((s) => s.id === sp.store) ?? stores[0];
  const qs = (t: Tab, extra = "") => `/employee/pharmacy?tab=${t}${store ? `&store=${store.id}` : ""}${extra}`;

  let body: React.ReactNode;
  if (tab === "dispense") {
    const queue = await dispensingQueue(ctx.tenantId, ctx.memberId, ctx.level);
    const held = await heldRxItems(ctx.tenantId, (queue ?? []).flatMap((rx) => rx.items.map((i) => i.id)));
    body = !queue ? <p className="text-ink-soft">Only a verified pharmacist sees the dispensing queue.</p> : queue.length === 0
      ? <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">No prescriptions waiting. Issued prescriptions from the last 14 days appear here until everything on them is dispensed.</p>
      : <div className="space-y-5">{queue.map((rx) => (
          <Panel key={rx.prescription_id} title={`${rx.patient.full_name} (${rx.patient.mrn})`} aside={<span className="text-sm text-ink-faint">{rx.rx_number}, {drName(rx.doctor)}, {new Date(rx.issued_at).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" })}</span>} flush>
            <div className="px-5 pt-4"><AllergyBanner allergy={rx.allergies.length ? rx.allergies.join(", ") : null} /></div>
            <ul className="divide-y divide-line">{rx.items.map((i) => (
              <li key={i.id} className={cn("grid gap-x-6 px-5 py-3 sm:grid-cols-[1.6fr_1fr_auto]", i.dispensed && "text-ink-faint")}>
                <div><div className="font-medium">{i.medicine_text}{i.strength ? ` ${i.strength}` : ""}{i.form ? ` (${i.form})` : ""}</div>
                  <div className="text-sm text-ink-soft">{[i.dose, i.frequency, i.duration_days ? `${i.duration_days} days` : null, i.instructions].filter(Boolean).join(", ")}</div></div>
                <div className="text-sm">{i.dispensed ? "Dispensed" : Number(i.dispensed_base) > 0 ? `${Number(i.dispensed_base)} given, ${i.remaining ?? ""} left` : "To dispense"}
                  {held.get(i.id) ? <span className="block text-warn">On hold {held.get(i.id)!.hold_no} until {when(held.get(i.id)!.expires_at)}</span> : null}</div>
                <div className="font-semibold sm:text-right">{i.quantity ?? ""}</div>
              </li>))}</ul>
            {canSell && store ? <div className="flex justify-end border-t border-line px-5 py-3"><Link href={qs("sale", `&rx=${rx.prescription_id}`)} className="rounded-control bg-pine px-4 py-2 font-medium text-white">Dispense and bill</Link></div> : null}
          </Panel>))}</div>;
  } else if (tab === "stock") {
    // Stock at PIN level (stock.operate, A1): what's on the shelf, transfers in and out, counts.
    // Adjustments, posting a count and disposal still need a password (Admin → Stock).
    const ss = await stockStores(ctx.tenantId, ctx.memberId);
    const here = ss.find((x) => x.id === sp.store) ?? ss.find((x) => x.id === store?.id) ?? ss[0];
    if (!here) {
      body = <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">You aren&apos;t assigned to a store. Ask the admin to add you to one.</p>;
    } else {
      const [lots, items, open] = await Promise.all([stockInStore(ctx.tenantId, here.id), listItems(ctx.tenantId), getOpenCount(ctx.tenantId, here.id)]);
      const term = String(sp.q ?? "").trim().toLowerCase().slice(0, 60);
      const rows = lots.map((l) => ({ l, it: items.find((i) => i.id === l.item_id) }))
        .filter(({ it }) => !term || `${it?.name ?? ""} ${it?.generic ?? ""} ${it?.item_code ?? ""}`.toLowerCase().includes(term))
        .sort((a, b) => (a.it?.name ?? "").localeCompare(b.it?.name ?? "") || (a.l.expiry_date ?? "9").localeCompare(b.l.expiry_date ?? "9"));
      const exp = (d: string | null) => (d ? new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`)) : "none");
      const sheet = lots.map((l) => { const it = items.find((i) => i.id === l.item_id); return { batch_id: l.batch_id, item: it?.name ?? "", batch_no: l.batch_no, expiry: exp(l.expiry_date), unit: it?.units.find((u) => u.is_base)?.name ?? "", system: l.qty_on_hand }; })
        .sort((a, b) => a.item.localeCompare(b.item));
      body = (
        <div className="space-y-6">
          <form action="/employee/pharmacy" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="tab" value="stock" />
            {ss.length > 1 ? <label><span className="block text-xs text-ink-faint">Store</span><select name="store" defaultValue={here.id} className="rounded-control border border-line-strong px-3 py-2">{ss.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label> : null}
            <label className="min-w-56 flex-1"><span className="block text-xs text-ink-faint">Find</span><input type="search" name="q" defaultValue={sp.q ?? ""} placeholder="Brand, generic or code" className="w-full rounded-control border border-line-strong px-3 py-2" /></label>
            <button className="rounded-control border border-line-strong px-3 py-2">Show</button>
          </form>
          <Panel title={`On hand in ${here.name}`} aside={<span className="text-sm text-ink-faint">{rows.length} batch{rows.length === 1 ? "" : "es"}</span>} flush>
            {rows.length === 0 ? <p className="px-5 py-4 text-ink-soft">{term ? "Nothing matches." : "Nothing in this store."}</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-left text-[0.95rem]">
                  <thead className="text-sm text-ink-faint"><tr><th className="px-5 py-2 font-medium">Medicine</th><th className="py-2 font-medium">Batch</th><th className="py-2 font-medium">Expires</th><th className="px-5 py-2 text-right font-medium">On hand</th></tr></thead>
                  <tbody className="divide-y divide-line">{rows.map(({ l, it }) => (
                    <tr key={l.batch_id}>
                      <td className="px-5 py-2">{it?.name}<span className="block text-xs text-ink-faint">{[it?.generic, it?.strength].filter(Boolean).join(" ")}</span></td>
                      <td className="py-2">{l.batch_no}{l.status !== "active" ? <span className="ml-2 text-xs text-alert">{l.status}</span> : null}</td>
                      <td className={cn("py-2", l.expired ? "text-alert" : l.near_expiry ? "text-warn" : "")}>{exp(l.expiry_date)}{l.expired ? " (expired)" : ""}</td>
                      <td className="px-5 py-2 text-right tabular-nums">{it ? packText(l.qty_on_hand, it.units) : l.qty_on_hand}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            )}
          </Panel>
          <Panel title={open ? `Stock count ${open.count_no}${open.blind ? " (blind)" : ""}` : "Stock count"}>
            {open ? <CountSheet countId={open.id} blind={open.blind} lots={sheet} lines={open.lines} canPost={ctx.permissions.has("manage_stock") && ctx.level !== "A1"} />
              : here.access !== "view" ? <StartCount storeId={here.id} /> : <p className="text-ink-soft">You can view this store only.</p>}
            {open && ctx.level === "A1" ? <p className="mt-2 text-sm text-ink-soft">You can count with your PIN; posting the count needs your password.</p> : null}
          </Panel>
        </div>
      );
    }
  } else if (!store) {
    body = <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">You aren&apos;t assigned to a store that sells. Ask the admin to add you to the pharmacy store.</p>;
  } else if (tab === "holds") {
    // M-45: stock kept aside for customers who collect later.
    const holds = await listHolds(ctx.tenantId, store.id);
    const open = holds.filter((h) => h.status === "held"), ended = holds.filter((h) => h.status !== "held");
    body = (
      <div className="space-y-6">
        <Panel title="On hold" aside={<span className="text-sm text-ink-faint">{open.length ? `${open.length} waiting` : "Use Hold for later on the Sale tab"}</span>} flush>
          {open.length === 0 ? <p className="px-5 py-4 text-ink-soft">Nothing on hold. To keep medicines aside for someone, add them on the Sale tab and choose Hold for later.</p> : (
            <ul className="divide-y divide-line">{open.map((h) => (
              <li key={h.id} className="grid gap-3 px-5 py-4 lg:grid-cols-[1fr_auto]">
                <div>
                  <div className="font-medium">{h.hold_no} · {h.customer}{h.phone ? <a href={`tel:${h.phone}`} className="ml-2 text-sm font-normal text-pine underline">{h.phone}</a> : null}</div>
                  <ul className="mt-1 text-sm">{h.lines.map((l, i) => <li key={i}>{l.item} <span className="text-ink-faint">batch {l.batch_no}</span> · {l.qty}{l.rx ? <span className="ml-1 text-xs text-ink-faint">(prescription)</span> : null}</li>)}</ul>
                  <div className={cn("mt-1 text-sm", h.overdue ? "text-alert" : "text-ink-soft")}>{h.overdue ? "Time ran out; it goes back to the shelf with the next sale." : `Held until ${when(h.expires_at)}`} · by {h.by}</div>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  {!h.overdue ? <Link href={qs("sale", `&hold=${h.id}`)} className="rounded-control bg-pine px-4 py-2 font-medium text-white">Collect and bill</Link> : null}
                  <ReleaseHold id={h.id} />
                </div>
              </li>))}</ul>
          )}
        </Panel>
        {ended.length ? (
          <Panel title="Ended in the last 3 days" flush>
            <ul className="divide-y divide-line text-sm">{ended.map((h) => (
              <li key={h.id} className="flex flex-wrap justify-between gap-x-4 px-5 py-2.5">
                <span><span className="font-medium">{h.hold_no}</span> · {h.customer} · {h.lines.map((l) => l.item).join(", ")}</span>
                <span className="text-ink-soft">{HOLD_STATUS[h.status]}{h.ended_at ? ` ${when(h.ended_at)}` : ""}{h.end_reason ? `: ${h.end_reason}` : ""}
                  {h.invoice_id ? <> · <Link href={`/employee/pharmacy/bills/${h.invoice_id}`} className="text-pine underline">bill</Link></> : null}</span>
              </li>))}</ul>
          </Panel>
        ) : null}
      </div>
    );
  } else if (tab === "sale") {
    const db = serviceClient();
    const [items, services, set] = await Promise.all([
      counterStock(ctx.tenantId, store.id), counterServices(ctx.tenantId),
      db.from("tenant_settings").select("allow_credit").eq("tenant_id", ctx.tenantId).single(),
    ]);
    let prefill: RxPrefill | null = null;
    let hold: HoldStart | null = null;
    if (sp.hold && UUID.test(sp.hold)) {
      const h = await holdForCollection(ctx.tenantId, store.id, sp.hold);
      if (h) hold = { ...h, patient: h.patient ? { id: h.patient.id, mrn: h.patient.mrn, full_name: h.patient.full_name, sex: h.patient.sex,
        age: ageText(h.patient.date_of_birth, h.patient.age_years, h.patient.created_at), phone: h.patient.phone, possible_duplicate: false } : null };
    }
    if (!hold && sp.rx && UUID.test(sp.rx) && canDispense) {
      const rx = (await dispensingQueue(ctx.tenantId, ctx.memberId, ctx.level))?.find((x) => x.prescription_id === sp.rx);
      if (rx) {
        const p = rx.patient;
        const lite: PatientLite = { id: p.id, mrn: p.mrn, full_name: p.full_name, sex: p.sex, age: ageText(p.date_of_birth, p.age_years, p.created_at), phone: null, possible_duplicate: false };
        prefill = { patient: lite, rxNumber: rx.rx_number, lines: rx.items.filter((i) => !i.dispensed).map((i) => ({ prescription_item_id: i.id, text: [i.medicine_text, i.strength, i.dose, i.frequency].filter(Boolean).join(" "),
          qty: i.remaining ?? i.quantity, item_id: i.item_id ?? null })) };
      }
    }
    body = <Panel title={hold ? `Collect ${hold.holdNo}` : prefill ? "Dispense" : "New sale"}>{sp.hold && !hold ? <p role="alert" className="mb-4 text-sm text-alert">That hold has ended or isn&apos;t in this store. Check the Holds tab.</p> : null}
      <CounterSale key={`${store.id}:${sp.rx ?? ""}:${sp.hold ?? ""}`} storeId={store.id} items={items} services={services} prefill={prefill} hold={hold}
      canOverride={ctx.permissions.has("override_batch")} canSellRx={ctx.permissions.has("sell_prescription_only")}
      allowCredit={Boolean((set.data as { allow_credit: boolean } | null)?.allow_credit) && ctx.permissions.has("allow_credit")} /></Panel>;
  } else {
    const [bills, alerts] = await Promise.all([todaysBills(ctx.tenantId, store.id), getAlerts(ctx.tenantId, store.id)]);
    const total = bills.filter((b) => b.status === "issued").reduce((s, b) => s + b.total, 0);
    body = (
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_20rem]">
        <Panel title="Recent bills" aside={<span className="text-sm text-ink-faint">{bills.length} bills, {npr(total)}</span>} flush>
          {bills.length === 0 ? <p className="px-5 py-4 text-ink-soft">No bills yet today.</p> : (
            <table className="w-full text-left text-[0.95rem]"><tbody className="divide-y divide-line">{bills.map((b) => (
              <tr key={b.id} className={b.status === "void" ? "text-ink-faint line-through" : ""}>
                <td className="px-5 py-2.5"><Link href={`/employee/pharmacy/bills/${b.id}`} className="font-medium text-pine hover:underline">{b.invoice_no}</Link></td>
                <td className="py-2.5">{b.customer}</td>
                <td className="py-2.5 text-sm text-ink-faint">{new Date(b.issued_at).toLocaleTimeString("en-GB", { timeZone: "Asia/Kathmandu", hour: "2-digit", minute: "2-digit" })}</td>
                <td className="px-5 py-2.5 text-right tabular-nums">{npr(b.total)}{b.paid < b.total ? <span className="block text-xs text-warn">due {npr(b.total - b.paid)}</span> : null}</td>
              </tr>))}</tbody></table>
          )}
        </Panel>
        <Panel title="Stock alerts" flush>
          {alerts.length === 0 ? <p className="px-5 py-4 text-sm text-ink-soft">Nothing expiring or running low.</p> : (
            <ul className="divide-y divide-line">{alerts.slice(0, 12).map((a, i) => (
              <li key={i} className="px-5 py-3">
                <div className={cn("text-sm font-medium", a.severity === "critical" ? "text-alert" : "text-warn")}>{ALERT_TEXT[a.kind]}</div>
                <div className="font-medium">{a.item}</div>
                <div className="text-sm text-ink-faint">{[a.batch_no ? `Batch ${a.batch_no}` : null, a.expiry_date ? `exp ${a.expiry_date}` : null, `${a.qty} on hand`].filter(Boolean).join(", ")}</div>
              </li>))}</ul>
          )}
        </Panel>
      </div>
    );
  }

  return (
    <>
      <LiveRefresh topics={["dispensing","billing","stock"]} />
      <PageHeader title="Pharmacy" subtitle={store ? `Selling from ${store.name}` : "Dispensing and sales"}
        actions={stores.length > 1 && tab !== "stock" ? <form action="/employee/pharmacy" className="flex gap-2"><input type="hidden" name="tab" value={tab} />
          <select name="store" defaultValue={store?.id} className="rounded-control border border-line-strong px-3 py-2">{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <button className="rounded-control border border-line-strong px-3 py-2">Switch</button></form> : null} />
      <nav aria-label="Pharmacy" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map(([t, label]) => (
          <Link key={t} href={qs(t)} aria-current={t === tab ? "page" : undefined}
            className={cn("whitespace-nowrap border-b-2 px-3 py-2.5 text-[0.95rem]", t === tab ? "border-pine font-medium text-pine-deep" : "border-transparent text-ink-soft hover:text-ink")}>{label}</Link>
        ))}
      </nav>
      {body}
    </>
  );
}
