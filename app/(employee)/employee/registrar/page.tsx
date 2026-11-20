import { DEMO_DOCTORS, DEMO_QUEUE, npr } from "@/lib/demo";
import { requireTenant } from "@/lib/auth/context";
import { Button, DemoNotice, PageHeader, Panel, StatusChip } from "@/components/ui/primitives";
import { OpdTicket } from "@/components/ui/opd-ticket";

export const dynamic = "force-dynamic";
export const metadata = { title: "Registrar" };

const field = "w-full rounded-control border border-line-strong bg-surface px-3 py-2.5 text-ink placeholder:text-ink-faint";

export default async function RegistrarDesk() {
  await requireTenant({ operation: "front_desk.operate", permission: "manage_queue", next: "/employee/registrar" });
  const nextToken = 16;
  const doctor = DEMO_DOCTORS[0]!;
  return (
    <>
      <PageHeader title="Registrar" subtitle="Registration, OPD fee and tokens" actions={<Button tone="secondary">New appointment</Button>} />
      <DemoNotice />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_1fr]">
        {/* Register / check-in is ONE flow: patient → doctor → OPD fee → payment → token (W-10). */}
        <Panel title="Register a patient">
          <form className="space-y-4" aria-describedby="reg-note">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Patient</span>
              <input className={field} placeholder="Name, phone or MRN. Search before adding new" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Doctor</span>
                <select className={field} defaultValue={doctor.id}>
                  {DEMO_DOCTORS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">OPD fee</span>
                <input className={field} defaultValue={npr(doctor.fee)} readOnly />
              </label>
            </div>
            <fieldset>
              <legend className="mb-1 text-sm font-medium">Payment</legend>
              <div className="grid grid-cols-3 gap-2">
                {["Cash", "Online", "Cash + online"].map((m, i) => (
                  <label key={m} className="flex cursor-pointer items-center justify-center rounded-control border border-line-strong px-2 py-2.5 text-sm has-[:checked]:border-pine has-[:checked]:bg-pine-tint has-[:checked]:font-medium has-[:checked]:text-pine-deep">
                    <input type="radio" name="method" className="sr-only" defaultChecked={i === 0} />
                    {m}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex items-end justify-between gap-4 border-t border-line pt-4">
              <OpdTicket token={nextToken} doctor={doctor.name} room={doctor.room} size="sm" />
              <Button type="button" className="flex-1">Bill and print token</Button>
            </div>
            <p id="reg-note" className="text-sm text-ink-faint">Creates the visit, issues the OPD bill, takes payment and prints the receipt with the token.</p>
          </form>
        </Panel>

        <div className="space-y-6">
          {DEMO_DOCTORS.map((d) => {
            const q = DEMO_QUEUE.filter((v) => v.doctorId === d.id);
            return (
              <Panel key={d.id} title={d.name} aside={<span className="text-sm text-ink-faint">{d.room} · {d.opd}</span>} flush>
                {q.length === 0 ? (
                  <p className="px-5 py-4 text-ink-soft">No patients yet. Registered patients appear here in token order.</p>
                ) : (
                  <table className="w-full text-left text-[0.95rem]">
                    <thead className="text-sm text-ink-faint">
                      <tr><th className="px-5 py-2 font-medium">Token</th><th className="py-2 font-medium">Patient</th><th className="hidden py-2 font-medium sm:table-cell">Time</th><th className="px-5 py-2 text-right font-medium">Status</th></tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {q.map((v) => (
                        <tr key={v.token}>
                          <td className="px-5 py-2.5"><span className="inline-block min-w-9 rounded bg-marigold-tint px-2 text-center font-bold text-marigold-ink">{v.token}</span></td>
                          <td className="py-2.5"><span className="font-medium">{v.patient}</span> <span className="text-ink-faint">{v.age}</span></td>
                          <td className="hidden py-2.5 text-ink-soft sm:table-cell">{v.time}{v.waitMin ? ` · waiting ${v.waitMin} min` : ""}</td>
                          <td className="px-5 py-2.5 text-right"><StatusChip status={v.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>
            );
          })}
        </div>
      </div>
    </>
  );
}
