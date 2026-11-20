import { DEMO_DISPENSING, DEMO_STOCK_ALERTS } from "@/lib/demo";
import { requireTenant } from "@/lib/auth/context";
import { redirect } from "next/navigation";
import { AllergyBanner, Button, DemoNotice, PageHeader, Panel } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pharmacy" };

const TABS = ["Dispense", "Sale", "Bills", "Stock", "Purchases"] as const;

const STOCK_NOTE = {
  ok: { label: "In stock", cls: "text-ok" },
  low: { label: "Low stock", cls: "text-warn" },
  near_expiry: { label: "Near expiry", cls: "text-warn" },
} as const;

export default async function PharmacyDesk() {
  const ctx = await requireTenant({ operation: "pharmacy.counter", next: "/employee/pharmacy" });
  if (!["pharmacy_sell", "dispense_prescription", "view_stock"].some((k) => ctx.permissions.has(k))) redirect("/employee");
  return (
    <>
      <PageHeader title="Pharmacy" subtitle="Dispensing, sales, billing and stock" actions={<Button>New sale</Button>} />
      <DemoNotice />

      {/* Tabs appear only for the keys the member holds (D-57). Only Dispense is laid out here. */}
      <div role="tablist" aria-label="Pharmacy" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t, i) => (
          <span key={t} role="tab" aria-selected={i === 0} className={cn("whitespace-nowrap border-b-2 px-3 py-2.5 text-[0.95rem]", i === 0 ? "border-pine font-medium text-pine-deep" : "border-transparent text-ink-faint")}>
            {t}
          </span>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <section aria-label="Prescriptions to dispense" className="space-y-5">
          {DEMO_DISPENSING.map((rx) => (
            <Panel key={rx.rx} title={rx.patient} aside={<span className="text-sm text-ink-faint">{rx.rx} · {rx.doctor} · {rx.issued}</span>} flush>
              <div className="px-5 pt-4"><AllergyBanner allergy={rx.allergy} /></div>
              <ul className="divide-y divide-line">
                {rx.lines.map((l) => (
                  <li key={l.medicine} className="grid gap-x-6 gap-y-1 px-5 py-3.5 sm:grid-cols-[1.6fr_1fr_auto]">
                    <div>
                      <div className="font-medium">{l.medicine}</div>
                      <div className="text-sm text-ink-soft">{l.dose}</div>
                    </div>
                    <div className="text-sm">
                      <div>Batch {l.batch} · exp {l.expiry}</div>
                      <div className={STOCK_NOTE[l.stock].cls}>{STOCK_NOTE[l.stock].label} · earliest expiry first</div>
                    </div>
                    <div className="font-semibold sm:text-right">{l.qty}</div>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
                <Button tone="quiet" type="button">Dispense part</Button>
                <Button type="button">Dispense and bill</Button>
              </div>
            </Panel>
          ))}
        </section>

        <Panel title="Stock alerts" flush>
          <ul className="divide-y divide-line">
            {DEMO_STOCK_ALERTS.map((a) => (
              <li key={a.item} className="px-5 py-3">
                <div className={cn("text-sm font-medium", a.kind === "expired" ? "text-alert" : a.kind === "near_expiry" ? "text-warn" : "text-ink-soft")}>
                  {a.kind === "expired" ? "Expired" : a.kind === "near_expiry" ? "Near expiry" : "Low stock"}
                </div>
                <div className="font-medium">{a.item}</div>
                <div className="text-sm text-ink-faint">{a.detail}</div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}
