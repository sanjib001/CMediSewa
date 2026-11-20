import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { requireTenant, can } from "@/lib/auth/context";
import { listPurchases, listVendorPayments, listVendors, vendorStatement } from "@/lib/purchasing/data";
import { payVendor, postVendorOpening, saveVendor } from "@/app/actions/purchasing";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { ButtonLink, PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Vendor" };
export const dynamic = "force-dynamic";

const npr = (n: number) => `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (s: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kathmandu" }).format(new Date(s));

export default async function VendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_vendors", allowPendingTenant: true, next: `/admin/vendors/${id}` });
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const v = (await listVendors(ctx.tenantId)).find((x) => x.id === id);
  if (!v) notFound();
  const [bills, payments, statement] = await Promise.all([listPurchases(ctx.tenantId, id), listVendorPayments(ctx.tenantId, id), vendorStatement(ctx.tenantId, id)]);
  const hasOpening = bills.some((b) => b.kind === "opening" && b.status === "posted");
  const open = bills.filter((b) => b.outstanding > 0).sort((a, b) => a.vendor_invoice_date.localeCompare(b.vendor_invoice_date));

  return (
    <>
      <PageHeader title={v.name} subtitle={<><Link href="/admin/vendors" className="text-pine hover:underline">Vendors</Link> / {v.vendor_code}. You owe <strong>{npr(v.payable)}</strong>{v.advance ? `, and have ${npr(v.advance)} paid in advance` : ""}.</>}
        actions={<>
          {can(ctx, "return_to_vendor") ? <ButtonLink tone="secondary" href={`/admin/purchases/returns/new?vendor=${v.id}`}>Return stock</ButtonLink> : null}
          {can(ctx, "manage_purchases") ? <ButtonLink href={`/admin/purchases/new?vendor=${v.id}`}>Enter a bill</ButtonLink> : null}
        </>} />
      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <div className="space-y-6">
          <Panel title="Bills" aside={<span className="text-sm text-ink-faint">{open.length} unpaid</span>} flush>
            {bills.length === 0 ? <p className="px-5 py-4 text-ink-soft">No bills yet.</p> : (
              <table className="w-full text-left text-[0.95rem]">
                <thead className="text-sm text-ink-faint"><tr><th className="px-5 py-2 font-medium">Bill</th><th className="py-2 font-medium">Date</th><th className="py-2 text-right font-medium">Total</th><th className="px-5 py-2 text-right font-medium">Still owed</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {bills.map((b) => (
                    <tr key={b.id} className={b.status === "void" ? "text-ink-faint line-through" : ""}>
                      <td className="px-5 py-2">{b.kind === "opening" ? "Opening balance" : <Link href={`/admin/purchases/${b.id}`} className="text-pine hover:underline">{b.vendor_invoice_no}</Link>}
                        <span className="block text-xs text-ink-faint">{b.purchase_no}</span></td>
                      <td className="py-2 text-sm">{b.vendor_invoice_date}</td>
                      <td className="py-2 text-right tabular-nums">{npr(b.total)}</td>
                      <td className={`px-5 py-2 text-right tabular-nums ${b.outstanding > 0 ? "font-medium" : "text-ink-faint"}`}>{b.outstanding > 0 ? npr(b.outstanding) : "paid"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Account statement" aside={<span className="text-sm text-ink-faint">From the accounts</span>} flush>
            {statement.length === 0 ? <p className="px-5 py-4 text-ink-soft">No entries yet.</p> : (
              <table className="w-full text-left text-sm">
                <thead className="text-ink-faint"><tr><th className="px-5 py-2 font-medium">Date</th><th className="py-2 font-medium">Document</th><th className="py-2 text-right font-medium">Bill / owed</th><th className="py-2 text-right font-medium">Paid</th><th className="px-5 py-2 text-right font-medium">Balance owed</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {statement.map((s, i) => (
                    <tr key={i}><td className="px-5 py-1.5">{day(s.at)}</td><td className="py-1.5">{s.doc}{s.memo ? ` (${s.memo})` : ""}</td>
                      <td className="py-1.5 text-right tabular-nums">{s.credit ? npr(s.credit) : ""}</td><td className="py-1.5 text-right tabular-nums">{s.debit ? npr(s.debit) : ""}</td>
                      <td className="px-5 py-1.5 text-right tabular-nums">{npr(s.balance)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          {can(ctx, "pay_vendors") ? (
            <Panel title="Pay this vendor" aside={<span className="text-sm text-ink-faint">Oldest bills first</span>}>
              <ActionForm action={payVendor} submitLabel="Record payment">
                <input type="hidden" name="vendor_id" value={v.id} /><input type="hidden" name="key" value={randomUUID()} />
                <div className="grid grid-cols-2 gap-3">
                  <label className="block"><span className={label}>Cash (Rs.)</span><input name="cash" inputMode="decimal" className={field} /></label>
                  <label className="block"><span className={label}>Online (Rs.)</span><input name="online" inputMode="decimal" className={field} /></label>
                  <label className="block"><span className={label}>Online via</span>
                    <select name="channel" className={field}><option value="bank_transfer">Bank transfer</option><option value="esewa">eSewa</option><option value="khalti">Khalti</option><option value="fonepay">Fonepay</option><option value="card">Card</option><option value="other">Other</option></select></label>
                  <label className="block"><span className={label}>Reference / cheque no.</span><input name="reference" className={field} /></label>
                </div>
                <p className="text-sm text-ink-faint">Anything more than the unpaid bills is kept as an advance.</p>
              </ActionForm>
              {payments.length ? (
                <ul className="mt-4 divide-y divide-line border-t border-line text-sm">
                  {payments.slice(0, 8).map((p) => <li key={p.id} className="flex justify-between py-1.5"><span>{p.payment_no}, {day(p.paid_at)}{p.reference ? `, ${p.reference}` : ""}</span><span className="tabular-nums">{npr(p.amount)}</span></li>)}
                </ul>
              ) : null}
            </Panel>
          ) : null}

          {!hasOpening && can(ctx, "manage_vendors") ? (
            <Panel title="Opening balance" aside={<span className="text-sm text-ink-faint">What you already owed on day one</span>}>
              <ActionForm action={postVendorOpening} submitLabel="Record opening balance" confirm="Record this opening balance? It goes into the accounts once.">
                <input type="hidden" name="vendor_id" value={v.id} /><input type="hidden" name="key" value={randomUUID()} />
                <div className="grid grid-cols-2 gap-3">
                  <label className="block"><span className={label}>Amount owed (Rs.)</span><input name="amount" required inputMode="decimal" className={field} /></label>
                  <label className="block"><span className={label}>As of</span><input name="as_of" type="date" className={field} /></label>
                </div>
              </ActionForm>
            </Panel>
          ) : null}

          <Panel title="Details">
            <ActionForm action={saveVendor} submitLabel="Save vendor" resetOnSuccess={false}>
              <input type="hidden" name="id" value={v.id} />
              <label className="block"><span className={label}>Name</span><input name="name" required defaultValue={v.name} className={field} /></label>
              <label className="block"><span className={label}>PAN / VAT</span><input name="pan_vat_no" defaultValue={v.pan_vat_no ?? ""} inputMode="numeric" pattern="\d{9}" className={field} /></label>
              <label className="block"><span className={label}>Contact person</span><input name="contact_person" defaultValue={v.contact_person ?? ""} className={field} /></label>
              <label className="block"><span className={label}>Phone</span><input name="phone" type="tel" defaultValue={v.phone ?? ""} className={field} /></label>
              <label className="block"><span className={label}>Email</span><input name="email" type="email" defaultValue={v.email ?? ""} className={field} /></label>
              <label className="block"><span className={label}>Address</span><input name="address" defaultValue={v.address ?? ""} className={field} /></label>
              <label className="block"><span className={label}>Payment terms (days)</span><input name="payment_terms_days" type="number" min={0} max={365} defaultValue={v.payment_terms_days ?? ""} className={field} /></label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_active" defaultChecked={v.is_active} />In use</label>
            </ActionForm>
          </Panel>
        </div>
      </div>
    </>
  );
}
