import Link from "next/link";
import { requireTenant, can } from "@/lib/auth/context";
import { lastPayableCheck, listVendors } from "@/lib/purchasing/data";
import { runPayableCheck, saveVendor } from "@/app/actions/purchasing";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Vendors" };
export const dynamic = "force-dynamic";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export default async function Vendors() {
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_vendors", allowPendingTenant: true, next: "/admin/vendors" });
  const [vendors, check] = await Promise.all([listVendors(ctx.tenantId), lastPayableCheck(ctx.tenantId)]);
  const owed = vendors.reduce((s, v) => s + v.payable, 0);
  return (
    <>
      <PageHeader title="Vendors" subtitle={`Who you buy from. You owe ${npr(owed)} in total.`} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Panel title="Vendors" flush>
          {vendors.length === 0 ? <p className="px-5 py-4 text-ink-soft">No vendors yet. Add the distributors you buy medicines from.</p> : (
            <table className="w-full text-left text-[0.95rem]">
              <thead className="text-sm text-ink-faint"><tr><th className="px-5 py-2 font-medium">Vendor</th><th className="py-2 font-medium">Contact</th><th className="px-5 py-2 text-right font-medium">You owe</th></tr></thead>
              <tbody className="divide-y divide-line">
                {vendors.map((v) => (
                  <tr key={v.id} className={v.is_active ? "" : "text-ink-faint"}>
                    <td className="px-5 py-2.5"><Link href={`/admin/vendors/${v.id}`} className="font-medium text-pine hover:underline">{v.name}</Link>
                      <span className="block text-xs text-ink-faint">{v.vendor_code}{v.pan_vat_no ? `, PAN ${v.pan_vat_no}` : ""}{v.is_active ? "" : ", not in use"}</span></td>
                    <td className="py-2.5 text-sm text-ink-soft">{[v.contact_person, v.phone].filter(Boolean).join(", ")}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{v.payable ? npr(v.payable) : "—"}{v.advance ? <span className="block text-xs text-ok">advance {npr(v.advance)}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <div className="space-y-6">
        {can(ctx, "manage_vendors") ? (
          <Panel title="Add a vendor">
            <ActionForm action={saveVendor} submitLabel="Add vendor">
              <label className="block"><span className={label}>Name</span><input name="name" required className={field} placeholder="e.g. Himalayan Pharma Distributors" /></label>
              <label className="block"><span className={label}>PAN / VAT</span><input name="pan_vat_no" inputMode="numeric" pattern="\d{9}" className={field} /></label>
              <label className="block"><span className={label}>Contact person</span><input name="contact_person" className={field} /></label>
              <label className="block"><span className={label}>Phone</span><input name="phone" type="tel" className={field} /></label>
              <label className="block"><span className={label}>Payment terms (days)</span><input name="payment_terms_days" type="number" min={0} max={365} className={field} /></label>
            </ActionForm>
          </Panel>
        ) : null}
        <Panel title="Payables check" aside={<span className="text-sm text-ink-faint">Runs every night</span>}>
          <p className="mb-3 text-sm text-ink-soft">What the accounts say you owe each vendor must equal their unpaid bills, payments and returns.
            {check ? <> Last checked {new Date(check.ran_at).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu" })}: {check.mismatches ? <span className="font-medium text-alert">{check.mismatches} vendor(s) differ</span> : `all ${check.vendors} match`}.</> : " Not checked yet."}</p>
          {can(ctx, "pay_vendors") ? <ActionForm action={runPayableCheck} submitLabel="Check now" tone="secondary"><></></ActionForm> : null}
        </Panel>
        </div>
      </div>
    </>
  );
}
