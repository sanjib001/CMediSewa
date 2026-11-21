import { requireSuperAdmin } from "@/lib/auth/guards";
import { getPlatformSettings } from "@/lib/platform/settings";
import { savePlatformSettings } from "@/app/actions/platform";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Platform settings" };
export const dynamic = "force-dynamic";

// Platform settings (U2): the support contact on the public Contact page, and whether new
// clinics can register. Every change is audited with before and after.
export default async function PlatformSettingsPage() {
  await requireSuperAdmin();
  const s = await getPlatformSettings();
  return (
    <>
      <PageHeader title="Platform settings" subtitle={s.updated_at ? `Last changed ${new Date(s.updated_at).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" })}.` : "Not set yet."} />
      <div className="max-w-2xl">
        <Panel title="Contact and registrations">
          <ActionForm action={savePlatformSettings} submitLabel="Save settings" resetOnSuccess={false}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className={label}>Support phone</span><input name="support_phone" type="tel" defaultValue={s.support_phone ?? ""} className={field} /></label>
              <label className="block"><span className={label}>WhatsApp</span><input name="support_whatsapp" type="tel" defaultValue={s.support_whatsapp ?? ""} className={field} /></label>
              <label className="block sm:col-span-2"><span className={label}>Support email</span><input name="support_email" type="email" defaultValue={s.support_email ?? ""} className={field} /></label>
              <label className="block sm:col-span-2"><span className={label}>Hours</span><input name="support_hours" maxLength={120} defaultValue={s.support_hours ?? ""} placeholder="e.g. Sunday–Friday, 9:00–18:00" className={field} /></label>
              <label className="block sm:col-span-2"><span className={label}>Office address</span><input name="office_address" maxLength={200} defaultValue={s.office_address ?? ""} className={field} /></label>
            </div>
            <label className="flex items-center gap-2"><input type="checkbox" name="registrations_open" defaultChecked={s.registrations_open} /> New clinics can register</label>
            <p className="text-sm text-ink-soft">These details appear on the public Contact page. While registrations are closed the form is hidden and submissions are refused.</p>
          </ActionForm>
        </Panel>
      </div>
    </>
  );
}
