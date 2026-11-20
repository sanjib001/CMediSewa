import Link from "next/link";
import { redirect } from "next/navigation";
import { requireTenant } from "@/lib/auth/context";
import { counterServices, counterStock, counterStores, dispensingQueue, patientsWithDues, todaysBills } from "@/lib/pharmacy/data";
import { CollectDues } from "@/components/pharmacy/bill-corrections";
import { getAlerts } from "@/lib/inventory/data";
import { ageText, type PatientLite } from "@/lib/desk/data";
import { serviceClient } from "@/lib/supabase/service";
import { CounterSale, type RxPrefill } from "@/components/pharmacy/counter";
import { AllergyBanner, PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pharmacy" };

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const UUID = /^[0-9a-f-]{36}$/;
const ALERT_TEXT = { expired: "Expired", blocked: "Blocked", near_expiry: "Near expiry", critical_stock: "Very low", low_stock: "Low stock" } as const;
type Tab = "dispense" | "sale" | "bills" | "dues";

// The pharmacy counter (W-14): the dispensing queue for pharmacists (C7: Rx items and
// allergies only), the sale screen, and recent bills. Tabs follow the keys held (D-57).
export default async function PharmacyDesk({ searchParams }: { searchParams: Promise<{ tab?: string; store?: string; rx?: string }> }) {
  const ctx = await requireTenant({ operation: "pharmacy.counter", next: "/employee/pharmacy" });
  if (!["pharmacy_sell", "dispense_prescription", "view_stock"].some((k) => ctx.permissions.has(k))) redirect("/employee");
  const sp = await searchParams;
  const canSell = ctx.permissions.has("pharmacy_sell"), canDispense = ctx.permissions.has("dispense_prescription");
  const tabs: [Tab, string][] = [];
  if (canDispense) tabs.push(["dispense", "Dispense"]);
  if (canSell) tabs.push(["sale", "Sale"], ["bills", "Bills"], ["dues", "Dues"]);
  const tab: Tab = sp.rx && canSell ? "sale" : tabs.find(([t]) => t === sp.tab)?.[0] ?? tabs[0]?.[0] ?? "bills";
  const stores = await counterStores(ctx.tenantId, ctx.memberId);
  const store = stores.find((s) => s.id === sp.store) ?? stores[0];
  const qs = (t: Tab, extra = "") => `/employee/pharmacy?tab=${t}${store ? `&store=${store.id}` : ""}${extra}`;

  let body: React.ReactNode;
  if (tab === "dispense") {
    const queue = await dispensingQueue(ctx.tenantId, ctx.memberId, ctx.level);
    body = !queue ? <p className="text-ink-soft">Only a verified pharmacist sees the dispensing queue.</p> : queue.length === 0
      ? <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">No prescriptions waiting. Issued prescriptions from the last 14 days appear here until everything on them is dispensed.</p>
      : <div className="space-y-5">{queue.map((rx) => (
          <Panel key={rx.prescription_id} title={`${rx.patient.full_name} (${rx.patient.mrn})`} aside={<span className="text-sm text-ink-faint">{rx.rx_number}, Dr. {rx.doctor ?? ""}, {new Date(rx.issued_at).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" })}</span>} flush>
            <div className="px-5 pt-4"><AllergyBanner allergy={rx.allergies.length ? rx.allergies.join(", ") : null} /></div>
            <ul className="divide-y divide-line">{rx.items.map((i) => (
              <li key={i.id} className={cn("grid gap-x-6 px-5 py-3 sm:grid-cols-[1.6fr_1fr_auto]", i.dispensed && "text-ink-faint")}>
                <div><div className="font-medium">{i.medicine_text}{i.strength ? ` ${i.strength}` : ""}{i.form ? ` (${i.form})` : ""}</div>
                  <div className="text-sm text-ink-soft">{[i.dose, i.frequency, i.duration_days ? `${i.duration_days} days` : null, i.instructions].filter(Boolean).join(", ")}</div></div>
                <div className="text-sm">{i.dispensed ? "Dispensed" : "To dispense"}</div>
                <div className="font-semibold sm:text-right">{i.quantity ?? ""}</div>
              </li>))}</ul>
            {canSell && store ? <div className="flex justify-end border-t border-line px-5 py-3"><Link href={qs("sale", `&rx=${rx.prescription_id}`)} className="rounded-control bg-pine px-4 py-2 font-medium text-white">Dispense and bill</Link></div> : null}
          </Panel>))}</div>;
  } else if (!store) {
    body = <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">You aren&apos;t assigned to a store that sells. Ask the admin to add you to the pharmacy store.</p>;
  } else if (tab === "dues") {
    const dues = await patientsWithDues(ctx.tenantId);
    body = dues.length === 0 ? <p className="rounded-panel border border-line bg-surface p-5 text-ink-soft">Nobody owes anything.</p> : (
      <Panel title="Patients who owe" aside={<span className="text-sm text-ink-faint">{npr(dues.reduce((s, d) => s + d.owed, 0))} in total</span>} flush>
        <ul className="divide-y divide-line">{dues.map((d) => (
          <li key={d.patient_id} className="grid gap-3 px-5 py-3 lg:grid-cols-[1fr_auto]">
            <div><div className="font-medium">{d.name} <span className="text-sm text-ink-faint">{d.mrn}{d.phone ? `, ${d.phone}` : ""}</span></div>
              <div className="text-sm text-ink-soft">Owes {npr(d.owed)} on {d.bills} bill{d.bills > 1 ? "s" : ""}, oldest {new Date(d.oldest).toLocaleDateString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium" })}</div></div>
            <CollectDues key={`${d.patient_id}:${d.owed}`} patientId={d.patient_id} owed={d.owed} />
          </li>))}</ul>
      </Panel>
    );
  } else if (tab === "sale") {
    const db = serviceClient();
    const [items, services, set] = await Promise.all([
      counterStock(ctx.tenantId, store.id), counterServices(ctx.tenantId),
      db.from("tenant_settings").select("allow_credit").eq("tenant_id", ctx.tenantId).single(),
    ]);
    let prefill: RxPrefill | null = null;
    if (sp.rx && UUID.test(sp.rx) && canDispense) {
      const rx = (await dispensingQueue(ctx.tenantId, ctx.memberId, ctx.level))?.find((x) => x.prescription_id === sp.rx);
      if (rx) {
        const p = rx.patient;
        const lite: PatientLite = { id: p.id, mrn: p.mrn, full_name: p.full_name, sex: p.sex, age: ageText(p.date_of_birth, p.age_years, p.created_at), phone: null, possible_duplicate: false };
        prefill = { patient: lite, rxNumber: rx.rx_number, lines: rx.items.filter((i) => !i.dispensed).map((i) => ({ prescription_item_id: i.id, text: [i.medicine_text, i.strength, i.dose, i.frequency].filter(Boolean).join(" "), qty: i.quantity })) };
      }
    }
    body = <Panel title={prefill ? "Dispense" : "New sale"}><CounterSale key={`${store.id}:${sp.rx ?? ""}`} storeId={store.id} items={items} services={services} prefill={prefill}
      canOverride={ctx.permissions.has("override_batch")} canSellRx={ctx.permissions.has("sell_prescription_only")}
      allowCredit={Boolean((set.data as { allow_credit: boolean } | null)?.allow_credit) && ctx.permissions.has("allow_credit")} /></Panel>;
  } else {
    const [bills, alerts] = await Promise.all([todaysBills(ctx.tenantId, store.id), getAlerts(ctx.tenantId, store.id)]);
    const total = bills.filter((b) => b.status === "issued").reduce((s, b) => s + b.total, 0);
    body = (
      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
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
      <PageHeader title="Pharmacy" subtitle={store ? `Selling from ${store.name}` : "Dispensing and sales"}
        actions={stores.length > 1 ? <form action="/employee/pharmacy" className="flex gap-2"><input type="hidden" name="tab" value={tab} />
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
