import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant, can } from "@/lib/auth/context";
import { getRecall } from "@/lib/inventory/recalls";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { PrintButton } from "@/components/pharmacy/print-button";

export const metadata = { title: "Recall" };
export const dynamic = "force-dynamic";

const when = (iso: string, time = true) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", ...(time ? { timeStyle: "short" } : {}) });
const qty = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
const STATUS: Record<string, string> = { active: "active", blocked: "blocked", recalled: "recalled" };

// One recall (M-51): its lots and what is left in each store (move it to quarantine from the
// store's stock page), and every bill that sold it, with whom to contact. Reading the list of
// buyers is audited.
export default async function Recall({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ operation: "admin.area", permission: "block_batches", allowPendingTenant: true, next: `/admin/stock/recalls/${id}` });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const r = await getRecall(ctx.tenantId, ctx.memberId, ctx.level, id);
  if (!r) notFound();
  const left = r.lots.reduce((s, l) => s + l.stores.reduce((t, x) => t + x.qty, 0), 0);
  const toContact = r.sales.filter((s) => s.sold - s.returned > 0);
  const patients = can(ctx, "view_patients");
  return (
    <>
      <PageHeader title={`Recall: ${r.item}, batch ${r.batch_no}`}
        subtitle={<><Link href="/admin/stock/recalls" className="text-pine hover:underline">Recalls</Link> / {when(r.at)}{r.by ? ` by ${r.by}` : ""}</>} />
      <section aria-label="Recall notice" className="mb-6 rounded-panel border border-alert/40 bg-surface p-5">
        <p className="font-semibold">{r.reason}</p>
        {r.reference ? <p className="text-sm text-ink-soft">Notice {r.reference}</p> : null}
        <p className="mt-2 text-sm text-ink-soft">This batch can&apos;t be sold in any store. {left > 0 ? `${qty(left)} ${r.unit} still on the shelves: move it to the quarantine store to return or dispose of it.` : "None is left on the shelves."}
          {" "}{toContact.length ? `${toContact.length} bill${toContact.length === 1 ? "" : "s"} sold it: contact those people.` : "Nobody has it from a sale."}</p>
        <div className="mt-3 print:hidden"><PrintButton label="Print this list" /></div>
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,24rem)_1fr]">
        <Panel title="Lots and stock left" flush>
          <ul className="divide-y divide-line">{r.lots.map((l) => (
            <li key={l.batch_id} className="px-5 py-3">
              <p className="text-sm">Lot {l.expiry ? `expiring ${when(`${l.expiry}T12:00:00+05:45`, false)}` : ""} <span className="text-ink-faint">(was {STATUS[l.was] ?? l.was}, now {STATUS[l.status] ?? l.status})</span></p>
              {l.stores.length ? <ul className="mt-1 text-sm">{l.stores.map((s) => (
                <li key={s.id} className="flex justify-between gap-3"><Link href={`/admin/stock?store=${s.id}`} className="text-pine hover:underline">{s.name}</Link><span className="tabular-nums">{qty(s.qty)} {r.unit}</span></li>))}</ul>
                : <p className="text-sm text-ink-soft">None left.</p>}
            </li>))}</ul>
        </Panel>

        <Panel title={`Who bought it (${r.sales.length})`} flush>
          {r.sales.length === 0 ? <p className="px-5 py-4 text-ink-soft">No bill sold this batch.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[0.95rem]">
                <thead className="border-b border-line text-sm text-ink-soft"><tr><th className="px-5 py-2 font-medium">Person</th><th className="py-2 font-medium">Phone</th><th className="py-2 font-medium">Bill</th><th className="px-5 py-2 text-right font-medium">Qty ({r.unit})</th></tr></thead>
                <tbody className="divide-y divide-line">{r.sales.map((s) => (
                  <tr key={s.invoice_id} className={s.sold - s.returned <= 0 ? "text-ink-faint" : ""}>
                    <td className="px-5 py-2.5">{s.patient_id && patients ? <Link href={`/admin/patients/${s.patient_id}`} className="text-pine hover:underline">{s.who}</Link> : s.who}{s.mrn ? <span className="block text-xs text-ink-faint">MRN {s.mrn}</span> : null}</td>
                    <td className="py-2.5 tabular-nums">{s.phone ? <a href={`tel:${s.phone.replace(/[^\d+]/g, "")}`} className="text-pine hover:underline">{s.phone}</a> : "—"}</td>
                    <td className="py-2.5 text-sm"><Link href={`/admin/billing/${s.invoice_id}`} className="text-pine hover:underline">{s.invoice_no}</Link><span className="block text-xs text-ink-faint">{when(s.at, false)}{s.store ? `, ${s.store}` : ""}</span></td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{qty(s.sold)}{s.returned ? <span className="block text-xs">{qty(s.returned)} returned</span> : null}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
