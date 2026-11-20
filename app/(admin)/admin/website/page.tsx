import Link from "next/link";
import { requireTenant } from "@/lib/auth/context";
import { getWebsite } from "@/lib/tenant/setup-data";
import { addAnnouncement, addFaq, deleteSiteItem, saveWebsite } from "@/app/actions/setup";
import { ActionForm, field, label } from "@/components/platform/action-form";
import { PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Clinic website" };
export const dynamic = "force-dynamic";

const small = "[&_button]:px-2 [&_button]:py-0.5 [&_button]:text-xs";

export default async function Website() {
  const ctx = await requireTenant({ operation: "admin.area", permission: "manage_website", allowPendingTenant: true, next: "/admin/website" });
  const { site, announcements, faqs } = await getWebsite(ctx.tenantId);
  const live = ctx.tenantStatus === "active" && site?.published;
  return (
    <>
      <PageHeader
        title="Clinic website"
        subtitle={<>Your public page at <Link className="text-pine underline" href={`/c/${ctx.tenantSlug}`} target="_blank">/c/{ctx.tenantSlug}</Link>. Doctors, services and fees come from your other settings.</>}
        actions={<span className={live ? "rounded-control bg-ok-tint px-3 py-1.5 text-sm text-ok" : "rounded-control bg-sunken px-3 py-1.5 text-sm text-ink-soft"}>
          {live ? "Public now" : site?.published ? "Published, goes public when the clinic goes live" : "Not published"}</span>}
      />
      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <Panel title="Page content">
          <ActionForm action={saveWebsite} submitLabel="Save website" resetOnSuccess={false}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block sm:col-span-2"><span className={label}>Headline</span><input name="hero_title" maxLength={120} defaultValue={site?.hero_title ?? ""} placeholder={ctx.tenantName} className={field} /></label>
              <label className="block sm:col-span-2"><span className={label}>One line under it</span><input name="hero_subtitle" maxLength={240} defaultValue={site?.hero_subtitle ?? ""} placeholder="e.g. Family doctors and a full pharmacy, open every day" className={field} /></label>
              <label className="block sm:col-span-2"><span className={label}>About the clinic</span><textarea name="about_md" rows={5} maxLength={4000} defaultValue={site?.about_md ?? ""} className={field} />
                <span className="mt-1 block text-xs text-ink-faint">Plain text. Blank lines start new paragraphs.</span></label>
              <label className="block"><span className={label}>Opening hours</span><input name="hours_text" maxLength={300} defaultValue={site?.hours_text ?? ""} placeholder="Sun–Fri 7am–7pm, Sat 9am–1pm" className={field} /></label>
              <label className="block"><span className={label}>Phone for patients</span><input name="contact_phone" type="tel" defaultValue={site?.contact_phone ?? ""} className={field} /></label>
              <label className="block"><span className={label}>WhatsApp</span><input name="whatsapp" type="tel" defaultValue={site?.whatsapp ?? ""} className={field} /></label>
              <label className="block"><span className={label}>Email for patients</span><input name="contact_email" type="email" defaultValue={site?.contact_email ?? ""} className={field} /></label>
              <label className="block sm:col-span-2"><span className={label}>Map link</span><input name="map_url" type="url" defaultValue={site?.map_url ?? ""} placeholder="https://maps.app.goo.gl/…" className={field} /></label>
              <label className="block"><span className={label}>Accent colour</span><input name="theme_color" type="color" defaultValue={site?.theme_color ?? "#0f5c4d"} className="h-10 w-20 rounded-control border border-line-strong" /></label>
              <div className="flex flex-col justify-end gap-1">
                <label className="flex items-center gap-2"><input type="checkbox" name="show_prices" defaultChecked={site?.show_prices ?? true} />Show fees and prices</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="booking_enabled" defaultChecked={site?.booking_enabled ?? true} />Take booking requests on the website</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="show_registration_numbers" defaultChecked={site?.show_registration_numbers ?? true} />Show doctors&apos; NMC numbers</label>
              </div>
              <label className="block"><span className={label}>Search title</span><input name="seo_title" maxLength={70} defaultValue={site?.seo_title ?? ""} className={field} /></label>
              <label className="block"><span className={label}>Search description</span><input name="seo_description" maxLength={170} defaultValue={site?.seo_description ?? ""} className={field} /></label>
            </div>
            <label className="flex items-center gap-2 rounded-control border border-line bg-sunken px-3 py-2 font-medium">
              <input type="checkbox" name="published" defaultChecked={site?.published ?? false} />Publish this page
            </label>
          </ActionForm>
        </Panel>

        <div className="space-y-6">
          <Panel title="Notices" flush>
            {announcements.length === 0 ? <p className="px-5 py-4 text-ink-soft">E.g. &ldquo;Closed on Dashain, 12–16 Ashwin&rdquo;.</p> : (
              <ul className="divide-y divide-line">{announcements.map((a) => (
                <li key={a.id} className="flex items-start gap-3 px-5 py-3">
                  <div className="flex-1"><div className="font-medium">{a.is_pinned ? "📌 " : ""}{a.title}</div>
                    <div className="text-sm text-ink-faint">{a.ends_at ? `Until ${a.ends_at.slice(0, 10)}` : "No end date"}</div></div>
                  <ActionForm action={deleteSiteItem} submitLabel="Remove" tone="secondary" className={small}><input type="hidden" name="type" value="announcement" /><input type="hidden" name="id" value={a.id} /></ActionForm>
                </li>))}</ul>
            )}
            <div className="border-t border-line p-5">
              <ActionForm action={addAnnouncement} submitLabel="Add notice">
                <label className="block"><span className={label}>Title</span><input name="title" required maxLength={120} className={field} /></label>
                <label className="block"><span className={label}>Details</span><textarea name="body_md" rows={2} maxLength={1500} className={field} /></label>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="block"><span className={label}>Show until</span><input name="ends_on" type="date" className={field} /></label>
                  <label className="flex items-center gap-2 pb-2"><input type="checkbox" name="is_pinned" />Pin to top</label>
                </div>
              </ActionForm>
            </div>
          </Panel>

          <Panel title="Common questions" flush>
            {faqs.length === 0 ? <p className="px-5 py-4 text-ink-soft">E.g. &ldquo;Do I need an appointment?&rdquo;</p> : (
              <ul className="divide-y divide-line">{faqs.map((f) => (
                <li key={f.id} className="flex items-start gap-3 px-5 py-3">
                  <div className="flex-1"><div className="font-medium">{f.question}</div><div className="text-sm text-ink-soft">{f.answer_md}</div></div>
                  <ActionForm action={deleteSiteItem} submitLabel="Remove" tone="secondary" className={small}><input type="hidden" name="type" value="faq" /><input type="hidden" name="id" value={f.id} /></ActionForm>
                </li>))}</ul>
            )}
            <div className="border-t border-line p-5">
              <ActionForm action={addFaq} submitLabel="Add question">
                <label className="block"><span className={label}>Question</span><input name="question" required maxLength={200} className={field} /></label>
                <label className="block"><span className={label}>Answer</span><textarea name="answer_md" required rows={2} maxLength={2000} className={field} /></label>
              </ActionForm>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
