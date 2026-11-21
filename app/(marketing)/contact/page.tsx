import Link from "next/link";
import { getPlatformSettings } from "@/lib/platform/settings";
import { ButtonLink } from "@/components/ui/primitives";

export const metadata = { title: "Contact", description: "Talk to the CMediSewa team about your clinic or pharmacy." };
export const revalidate = 300;

// Contact (U2): the support details set by the platform (Super Admin → Platform settings).
// No message form on purpose: no spam inbox, and clinics in Nepal reach us by phone or WhatsApp.
export default async function Contact() {
  const s = await getPlatformSettings();
  const wa = s.support_whatsapp?.replace(/\D/g, "");
  const any = s.support_phone || s.support_email || wa;
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-5 sm:px-6">
        <Link href="/" className="text-xl font-semibold">CMediSewa</Link>
        <Link href="/login" className="text-ink-soft hover:text-ink">Sign in</Link>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        <h1 className="text-[2rem] font-semibold leading-tight">Talk to us</h1>
        <p className="mt-2 max-w-xl text-ink-soft">Questions about CMediSewa for your clinic or pharmacy, a demo, or help with your account.</p>
        {any ? (
          <dl className="mt-8 grid max-w-lg gap-4 rounded-panel border border-line bg-surface p-6 text-lg">
            {s.support_phone ? <div><dt className="text-sm text-ink-faint">Phone</dt><dd><a href={`tel:${s.support_phone.replace(/[^\d+]/g, "")}`} className="font-medium text-pine hover:underline">{s.support_phone}</a></dd></div> : null}
            {wa ? <div><dt className="text-sm text-ink-faint">WhatsApp</dt><dd><a href={`https://wa.me/${wa}`} className="font-medium text-pine hover:underline" rel="noopener" target="_blank">{s.support_whatsapp}</a></dd></div> : null}
            {s.support_email ? <div><dt className="text-sm text-ink-faint">Email</dt><dd><a href={`mailto:${s.support_email}`} className="font-medium text-pine hover:underline">{s.support_email}</a></dd></div> : null}
            {s.support_hours ? <div><dt className="text-sm text-ink-faint">Hours</dt><dd>{s.support_hours}</dd></div> : null}
            {s.office_address ? <div><dt className="text-sm text-ink-faint">Office</dt><dd>{s.office_address}</dd></div> : null}
          </dl>
        ) : <p className="mt-8 text-ink-soft">Contact details will be published here soon.</p>}
        <p className="mt-8 text-ink-soft">Ready to start?</p>
        <div className="mt-3"><ButtonLink href="/register">Register your clinic</ButtonLink></div>
        <p className="mt-10 text-sm text-ink-faint">Already a clinic on CMediSewa? Patients should contact their clinic directly; we can&apos;t see or change medical records.</p>
      </main>
    </div>
  );
}
