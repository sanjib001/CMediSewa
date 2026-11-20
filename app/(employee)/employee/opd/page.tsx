import { DEMO_DOCTORS, DEMO_QUEUE } from "@/lib/demo";
import { requireTenant } from "@/lib/auth/context";
import { AllergyBanner, Button, DemoNotice, PageHeader, Panel, StatusChip } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";

export const dynamic = "force-dynamic";
export const metadata = { title: "OPD" };

const area = "w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-ink placeholder:text-ink-faint";

export default async function OpdDesk() {
  // Clinical work needs a password session (A2), and doctors also finish 2FA (P-11).
  await requireTenant({ operation: "clinical.chart", permission: "write_consultation", next: "/employee/opd" });
  const doctor = DEMO_DOCTORS[0]!;
  const queue = DEMO_QUEUE.filter((v) => v.doctorId === doctor.id);
  const current = queue.find((v) => v.status === "with_doctor")!;
  return (
    <>
      <PageHeader title="OPD" subtitle={`${doctor.name} · ${doctor.room}`} actions={<Button>Call next</Button>} />
      <DemoNotice>Layout preview with demo data. In use, opening a patient&apos;s record asks for your password (a PIN session is not enough), and every opening is logged.</DemoNotice>

      <div className="grid gap-6 lg:grid-cols-[17rem_1fr]">
        <Panel title="My queue" flush>
          <ul className="divide-y divide-line">
            {queue.map((v) => (
              <li key={v.token} className={cn("flex items-center gap-3 px-4 py-3", v.status === "with_doctor" && "bg-pine-tint")}>
                <span className="inline-block min-w-9 rounded bg-marigold-tint px-2 text-center font-bold text-marigold-ink">{v.token}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{v.patient}</span>
                  <span className="block text-sm text-ink-faint">{v.age}</span>
                </span>
                {v.status !== "waiting" ? <StatusChip status={v.status} /> : <span className="text-sm text-ink-faint">{v.waitMin} min</span>}
              </li>
            ))}
          </ul>
        </Panel>

        <section aria-label="Consultation" className="space-y-5">
          <div className="rounded-panel border border-line bg-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">{current.patient} <span className="font-normal text-ink-faint">{current.age}</span></h2>
                <p className="text-sm text-ink-faint">MRN AR-2083-000213 (demo) · Token {current.token} · last visit 2083 Kartik 12</p>
              </div>
              <AllergyBanner allergy="Sulfa drugs" />
            </div>
            <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-t border-line pt-4 text-[0.95rem]">
              {[["BP", "138/86"], ["Pulse", "78"], ["Temp", "37.1 °C"], ["SpO₂", "97%"], ["Weight", "68 kg"]].map(([k, v]) => (
                <div key={k} className="flex items-baseline gap-2"><dt className="text-sm text-ink-faint">{k}</dt><dd className="font-medium">{v}</dd></div>
              ))}
            </dl>
          </div>

          <Panel title="Consultation">
            <div className="grid gap-4 md:grid-cols-2">
              {["Chief complaint", "History", "Examination", "Diagnosis"].map((label) => (
                <label key={label} className="block">
                  <span className="mb-1 block text-sm font-medium">{label}</span>
                  <textarea rows={3} className={area} />
                </label>
              ))}
              <label className="block md:col-span-2">
                <span className="mb-1 block text-sm font-medium">Plan and advice</span>
                <textarea rows={2} className={area} />
              </label>
            </div>
          </Panel>

          <Panel title="Prescription" aside={<span className="text-sm text-ink-faint">Sent to the pharmacy when you finalize</span>}>
            <div className="space-y-3">
              <div className="grid grid-cols-[1fr_auto] gap-3 rounded-control border border-line p-3 sm:grid-cols-[2fr_1.5fr_auto]">
                <div><div className="font-medium">Amlodipine 5 mg tab</div><div className="text-sm text-ink-faint">In stock · pharmacy</div></div>
                <div className="text-ink-soft max-sm:col-span-2 max-sm:row-start-2">1 tab once daily × 30 days · 30 tab</div>
                <button type="button" className="self-start text-sm text-ink-faint hover:text-alert">Remove</button>
              </div>
              <label className="flex items-center gap-2 rounded-control border border-dashed border-line-strong px-3 py-2.5 text-ink-faint">
                <Icon name="Search" />
                <input className="w-full bg-transparent text-ink placeholder:text-ink-faint focus:outline-none" placeholder="Add a medicine by brand or generic name" />
              </label>
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-line pt-4">
              <Button tone="secondary" type="button">Save draft</Button>
              <Button type="button">Finalize and send to pharmacy</Button>
            </div>
          </Panel>
        </section>
      </div>
    </>
  );
}
