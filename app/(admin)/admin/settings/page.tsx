import { requireTenant } from "@/lib/auth/context";
import { getClinicSettings } from "@/lib/tenant/setup-data";
import { saveBillingProfile, saveClinicProfile, saveOperatingSettings } from "@/app/actions/setup";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

function Text({ name, title, value, hint, ...rest }: { name: string; title: string; value?: string | number | null; hint?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value">) {
  return (
    <label className="block">
      <span className={label}>{title}</span>
      <input name={name} defaultValue={value ?? ""} className={field} {...rest} />
      {hint ? <span className="mt-1 block text-xs text-ink-faint">{hint}</span> : null}
    </label>
  );
}
function Choice({ name, title, value, options }: { name: string; title: string; value?: string; options: [string, string][] }) {
  return (
    <label className="block">
      <span className={label}>{title}</span>
      <select name={name} defaultValue={value} className={field}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
    </label>
  );
}

// Viewing needs the Admin area; saving needs a password check within the last 5 minutes
// (settings.change), so the page asks for it only when you save.
export default async function Settings() {
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_settings", allowPendingTenant: true, next: "/admin/settings" });
  const { clinic: c, settings: s, billing: b } = await getClinicSettings(ctx.tenantId);
  return (
    <>
      <PageHeader title="Settings" subtitle="Clinic details, what prints on bills, and how the clinic runs day to day. Saving asks you to confirm your password if you haven't recently." />
      <div className="space-y-6">
        <Panel title="Clinic details">
          <ActionForm action={saveClinicProfile} submitLabel="Save clinic details" resetOnSuccess={false}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Text name="name" title="Clinic name" value={c.name} required />
              <Text name="legal_name" title="Registered name" value={c.legal_name} />
              <Text name="pan_number" title="PAN" value={c.pan_number} inputMode="numeric" pattern="\d{9}" hint="9 digits" />
              <Text name="registration_no" title="Registration number" value={c.registration_no} />
              <Text name="phone" title="Phone" value={c.phone} type="tel" hint="Needed before going live" />
              <Text name="email" title="Email" value={c.email} type="email" />
              <Text name="address_province" title="Province" value={c.address_province} />
              <Text name="address_district" title="District" value={c.address_district} />
              <Text name="address_municipality" title="Municipality" value={c.address_municipality} />
              <Text name="address_ward" title="Ward" value={c.address_ward} />
              <div className="sm:col-span-2"><Text name="address_street" title="Street / tole" value={c.address_street} /></div>
            </div>
          </ActionForm>
        </Panel>

        <Panel title="On every bill" aside={<span className="text-sm text-ink-faint">Clinic and pharmacy share this header and one bill series</span>}>
          {b ? (
            <ActionForm action={saveBillingProfile} submitLabel="Save bill header" resetOnSuccess={false}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Text name="legal_name" title="Legal name on bills" value={b.legal_name} required />
                <Text name="pan_vat_no" title="PAN / VAT number" value={b.pan_vat_no} inputMode="numeric" pattern="\d{9}" />
                <Text name="registration_no" title="Registration number" value={b.registration_no} />
                <Text name="phone" title="Phone on bills" value={b.phone} type="tel" />
                <div className="sm:col-span-2"><Text name="address" title="Address on bills" value={b.address} /></div>
                <Text name="invoice_prefix" title="Bill number prefix" value={b.invoice_prefix} maxLength={12} hint="Optional, e.g. ARG. Bill numbers restart each fiscal year." />
                <Text name="receipt_footer" title="Footer line" value={b.receipt_footer} hint="E.g. 'Medicines once sold are returnable within 7 days with the bill.'" />
              </div>
            </ActionForm>
          ) : <p className="text-ink-soft">No billing profile found. Contact CMediSewa support.</p>}
        </Panel>

        {s ? (
          <Panel title="How the clinic runs">
            <ActionForm action={saveOperatingSettings} submitLabel="Save settings" resetOnSuccess={false}>
              <fieldset className="grid gap-3 sm:grid-cols-3">
                <legend className="mb-2 font-medium">Appointments</legend>
                <Choice name="scheduling_mode" title="OPD style" value={s.scheduling_mode} options={[["both", "Time slots and tokens"], ["slot", "Time slots only"], ["token", "Tokens only"]]} />
                <Text name="booking_window_days" title="Book up to (days ahead)" value={s.booking_window_days} type="number" min={1} max={365} />
                <Text name="min_notice_minutes" title="Online booking notice (minutes)" value={s.min_notice_minutes} type="number" min={0} max={10080} />
                <Text name="cancellation_cutoff_hours" title="Cancel up to (hours before)" value={s.cancellation_cutoff_hours} type="number" min={0} max={168} />
                <Choice name="consultation_billing_point" title="Charge the OPD fee" value={s.consultation_billing_point} options={[["check_in", "At registration"], ["checkout", "After the consultation"], ["none", "Don't charge in the system"]]} />
                <label className="flex items-center gap-2 self-end pb-2"><input type="checkbox" name="auto_confirm_online" defaultChecked={s.auto_confirm_online} />Confirm online bookings automatically</label>
              </fieldset>
              <fieldset className="grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
                <legend className="mb-2 pt-2 font-medium">Sign-in on shared counters</legend>
                <Choice name="pin_policy" title="Staff PIN" value={s.pin_policy} options={[["allowed", "Allowed on trusted devices"], ["required", "Required on trusted devices"], ["off", "Off (password every time)"]]} />
                <Text name="idle_lock_minutes" title="Lock the screen after (minutes idle)" value={s.idle_lock_minutes} type="number" min={1} max={240} />
                <Text name="shift_window_hours" title="PIN works for (hours after password)" value={s.shift_window_hours} type="number" min={1} max={24} />
              </fieldset>
              <fieldset className="grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
                <legend className="mb-2 pt-2 font-medium">Billing and reminders</legend>
                <label className="flex items-center gap-2 self-end pb-2"><input type="checkbox" name="allow_credit" defaultChecked={s.allow_credit} />Patients may leave part of a bill unpaid</label>
                <Text name="credit_limit_per_patient" title="Most a patient may owe (Rs.)" value={s.credit_limit_per_patient} type="number" min={0} max={10000000} step="0.01" hint="Only staff allowed to give credit can leave a due." />
                <Text name="max_discount_pct_without_reauth" title="Discount allowed without approval (%)" value={s.max_discount_pct_without_reauth} type="number" min={0} max={100} step="0.01" hint="Above this, someone who may approve discounts must give it." />
                <Text name="reminder_hours_before" title="Email a reminder (hours before)" value={s.reminder_hours_before} type="number" min={0} max={72} hint="0 = no reminders. Patients with an email get it." />
              </fieldset>
              <fieldset className="grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
                <legend className="mb-2 pt-2 font-medium">Pharmacy and printing</legend>
                <Text name="near_expiry_days" title="Warn about expiry (days before)" value={s.near_expiry_days} type="number" min={1} max={730} />
                <Text name="critical_expiry_days" title="Urgent expiry (days before)" value={s.critical_expiry_days} type="number" min={0} max={365} />
                <Choice name="print_paper_width" title="Receipt paper" value={s.print_paper_width} options={[["80mm", "80 mm thermal"], ["58mm", "58 mm thermal"], ["a5", "A5"], ["a4", "A4"]]} />
              </fieldset>
            </ActionForm>
          </Panel>
        ) : null}
      </div>
    </>
  );
}
