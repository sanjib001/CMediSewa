import { notFound } from "next/navigation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { getTenantDetail, listPlans, npr } from "@/lib/platform/admin-data";
import { setTenantStatus, addSubscription, issueInvoice, recordPayment, reissueAdminInvite, verifyCredentialAsPlatform } from "@/app/actions/platform";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { formatKathmandu } from "@/lib/platform/overview";
import { isoDate, localDate } from "@/lib/clinic-time";
import { cn } from "@/lib/cn";

export const metadata = { title: "Clinic" };
export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  active: "bg-ok-tint text-ok", pending: "bg-sunken text-ink-soft", suspended: "bg-alert-tint text-alert", closed: "bg-sunken text-ink-faint",
};

export default async function ClinicDetail({ params }: { params: Promise<{ id: string }> }) {
  await requireSuperAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [d, plans] = await Promise.all([getTenantDetail(id), listPlans()]);
  if (!d) notFound();
  const t = d.tenant;
  const today = isoDate(localDate(new Date()));
  const admin = d.admins[0];
  const pendingInvite = admin && !admin.auth_user_id ? d.invites.find((i) => i.member_id === admin.id && !i.used_at && !i.revoked_at) : null;

  return (
    <>
      <PageHeader
        title={t.name!}
        subtitle={<>/{t.slug} · <span className={cn("rounded-full px-2 py-0.5 text-sm font-medium capitalize", STATUS_STYLE[t.status!])}>{t.status}</span>{t.status_reason ? <span className="text-ink-faint"> · {t.status_reason === "subscription_expired" ? "subscription expired" : t.status_reason}</span> : null}</>}
      />
      <div className="grid gap-6 xl:grid-cols-[1.3fr_1fr]">
        <div className="space-y-6">
          <Panel title="Subscription" aside={<span className="text-sm text-ink-faint">Paid until {d.paidUntil ?? "no period"}</span>} flush>
            <table className="w-full text-left text-[0.95rem]">
              <thead className="text-sm text-ink-faint"><tr><th className="px-5 py-2 font-medium">Plan</th><th className="py-2 font-medium">Period</th><th className="py-2 font-medium">Type</th><th className="px-5 py-2 text-right font-medium">Price</th></tr></thead>
              <tbody className="divide-y divide-line">
                {d.subscriptions.map((s) => (
                  <tr key={s.id}><td className="px-5 py-2.5">{s.plans?.name ?? "?"}</td><td className="py-2.5">{s.starts_on} → {s.ends_on}</td><td className="py-2.5 capitalize">{s.source}</td><td className="px-5 py-2.5 text-right">{npr(s.price_npr)}</td></tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-line p-5">
              <ActionForm action={addSubscription} submitLabel="Add period">
                <input type="hidden" name="tenant_id" value={id} />
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block"><span className={label}>Plan</span><select name="plan_id" className={field}>{plans.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                  <label className="block"><span className={label}>Starts on</span><input name="starts_on" type="date" defaultValue={d.paidUntil && d.paidUntil >= today ? d.paidUntil : today} className={field} /></label>
                  <label className="block"><span className={label}>Days</span><input name="period_days" type="number" min={1} max={1100} defaultValue={365} className={field} /></label>
                  <label className="block"><span className={label}>Type</span><select name="source" className={field}><option value="paid">Paid</option><option value="extension">Extension</option><option value="complimentary">Complimentary</option><option value="trial">Trial</option></select></label>
                  <label className="block"><span className={label}>Price (Rs.)</span><input name="price_npr" type="number" min={0} step="0.01" className={field} /></label>
                  <label className="block"><span className={label}>Note</span><input name="note" className={field} /></label>
                </div>
              </ActionForm>
            </div>
          </Panel>

          <Panel title="Invoices" flush>
            {d.invoices.length === 0 ? <p className="px-5 py-4 text-ink-soft">No invoices yet.</p> : (
              <ul className="divide-y divide-line">
                {d.invoices.map((i) => (
                  <li key={i.id} className="px-5 py-3">
                    <div className="flex flex-wrap justify-between gap-2">
                      <div><span className="font-medium">{i.invoice_no}</span> <span className="text-ink-soft">· {i.description}</span></div>
                      <div className="text-right">{npr(i.amount_npr)} <span className={i.balance > 0 ? "text-warn" : "text-ok"}>· {i.balance > 0 ? `${npr(i.balance)} due` : "paid"}</span></div>
                    </div>
                    {i.balance > 0 && i.status !== "void" ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-sm text-pine">Record a payment</summary>
                        <ActionForm action={recordPayment} submitLabel="Record payment" className="mt-2">
                          <input type="hidden" name="invoice_id" value={i.id} /><input type="hidden" name="tenant_id" value={id} />
                          <div className="grid gap-3 sm:grid-cols-4">
                            <label className="block"><span className={label}>Amount</span><input name="amount_npr" type="number" step="0.01" defaultValue={i.balance} className={field} /></label>
                            <label className="block"><span className={label}>Method</span><select name="method" className={field}>{["bank_transfer", "esewa", "khalti", "fonepay", "cash", "cheque", "other"].map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}</select></label>
                            <label className="block"><span className={label}>Reference</span><input name="reference" className={field} /></label>
                            <label className="block"><span className={label}>Received on</span><input name="received_on" type="date" defaultValue={today} className={field} /></label>
                          </div>
                        </ActionForm>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-line p-5">
              <ActionForm action={issueInvoice} submitLabel="Issue invoice">
                <input type="hidden" name="tenant_id" value={id} />
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block sm:col-span-3"><span className={label}>For</span><input name="description" placeholder="Annual subscription 2083/84" className={field} /></label>
                  <label className="block"><span className={label}>Amount (Rs.)</span><input name="amount_npr" type="number" min={1} step="0.01" className={field} /></label>
                  <label className="block"><span className={label}>Due on</span><input name="due_on" type="date" className={field} /></label>
                </div>
              </ActionForm>
            </div>
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Clinic">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.95rem]">
              <dt className="text-ink-faint">Legal name</dt><dd>{t.legal_name ?? "not set"}</dd>
              <dt className="text-ink-faint">PAN</dt><dd>{t.pan_number ?? "not set"}</dd>
              <dt className="text-ink-faint">Phone</dt><dd>{t.phone ?? "not set"}</dd>
              <dt className="text-ink-faint">Email</dt><dd>{t.email ?? "not set"}</dd>
              <dt className="text-ink-faint">Place</dt><dd>{[t.address_municipality, t.address_district].filter(Boolean).join(", ") || "not set"}</dd>
              <dt className="text-ink-faint">Active staff</dt><dd>{d.staffCount}</dd>
              <dt className="text-ink-faint">Joined</dt><dd>{formatKathmandu(t.created_at!)}</dd>
            </dl>
          </Panel>

          <Panel title="Clinic admin">
            {admin ? (
              <>
                <p className="font-medium">{admin.display_name}</p>
                <p className="text-ink-soft">{admin.email}</p>
                <p className="mt-2 text-sm">{admin.auth_user_id ? <span className="text-ok">Has signed up</span> : pendingInvite ? <span className="text-warn">Invite sent, expires {formatKathmandu(pendingInvite.expires_at)}</span> : <span className="text-warn">No active invite</span>}</p>
                {!admin.auth_user_id ? (
                  <ActionForm action={reissueAdminInvite} submitLabel="Create a new invite link" tone="secondary" className="mt-3">
                    <input type="hidden" name="tenant_id" value={id} /><input type="hidden" name="member_id" value={admin.id} />
                  </ActionForm>
                ) : null}
              </>
            ) : <p className="text-ink-soft">No clinic admin.</p>}
          </Panel>

          <Panel title="Registrations" aside={<span className="text-sm text-ink-faint">{d.credentials.filter((c) => !c.verified_at).length} waiting</span>}>
            {d.credentials.length === 0 ? <p className="text-ink-soft">None yet.</p> : (
              <ul className="space-y-3">
                {d.credentials.map((c) => (
                  <li key={c.id} className="text-sm">
                    <p className="font-medium">{c.member_name}</p>
                    <p className="text-ink-soft">{c.profession.replace("_", " ")}: {c.council} {c.registration_no}</p>
                    {c.verified_at ? <p className="text-ok">Verified {formatKathmandu(c.verified_at)}</p> : (
                      <ActionForm action={verifyCredentialAsPlatform} submitLabel="Checked with the council: verify" tone="secondary" className="mt-1 [&_button]:px-2.5 [&_button]:py-1 [&_button]:text-sm"
                        confirm={`Confirm you checked ${c.council} ${c.registration_no} for ${c.member_name} with the council's register.`}>
                        <input type="hidden" name="tenant_id" value={id} /><input type="hidden" name="credential_id" value={c.id} />
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Status">
            <ActionForm action={setTenantStatus} submitLabel="Change status" tone="secondary" confirm="Change this clinic's status?">
              <input type="hidden" name="tenant_id" value={id} />
              <label className="block"><span className={label}>New status</span>
                <select name="status" className={field} defaultValue={t.status === "active" ? "suspended" : "active"}>
                  <option value="active">Active (live)</option><option value="suspended">Suspended (read-only admin, no staff or booking)</option><option value="closed">Closed (permanent)</option>
                </select></label>
              <label className="block"><span className={label}>Reason (kept in the record)</span><input name="reason" required className={field} /></label>
            </ActionForm>
          </Panel>
        </div>
      </div>
    </>
  );
}
