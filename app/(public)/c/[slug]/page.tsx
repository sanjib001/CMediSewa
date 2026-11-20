import { cache } from "react";
import { notFound } from "next/navigation";
import { serviceClient } from "@/lib/supabase/service";
import { Icon } from "@/components/ui/icon";

// The clinic's public website (U7, D-34). Everything shown comes from public_clinic_profile():
// an allow-list of fields, only for an ACTIVE clinic with a PUBLISHED site, and only doctors
// with a verified registration. No other table is read here. Content is plain text: React
// escapes it, and no HTML from the clinic is ever rendered.

type Profile = {
  name: string; slug: string; address: string; phone: string | null; email: string | null; whatsapp: string | null;
  map_url: string | null; hours: string | null; theme_color: string; hero_title: string; hero_subtitle: string | null;
  about: string | null; seo_title: string | null; seo_description: string | null; booking_enabled: boolean;
  departments: { id: string; name: string; description: string | null }[];
  services: { name: string; kind: string; price: number | null }[];
  doctors: { id: string; name: string; specialty: string | null; qualification: string | null; bio: string | null; fee: number | null;
    registration: string | null; opd: { weekday: number; start: string; end: string }[] | null }[];
  announcements: { title: string; body: string | null }[];
  faqs: { q: string; a: string }[];
};

const getProfile = cache(async (slug: string): Promise<Profile | null> => {
  if (!/^[a-z0-9-]{2,50}$/.test(slug)) return null;
  const { data, error } = await serviceClient().rpc("public_clinic_profile", { p_slug: slug });
  if (error) throw new Error(`public profile: ${error.message}`);
  return (data as Profile | null) ?? null;
});

export const revalidate = 120;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const p = await getProfile((await params).slug);
  if (!p) return { title: "Clinic not found", robots: { index: false } };
  return { title: { absolute: p.seo_title || p.name }, description: p.seo_description || p.hero_subtitle || undefined };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const npr = (n: number) => `Rs. ${Number(n).toLocaleString("en-IN")}`;

/** "Sun, Mon 09:00–13:00; Wed 15:00–17:00": windows with the same hours grouped. */
function opdText(opd: Profile["doctors"][number]["opd"]): string | null {
  if (!opd?.length) return null;
  const groups = new Map<string, number[]>();
  for (const w of opd) groups.set(`${w.start}–${w.end}`, [...(groups.get(`${w.start}–${w.end}`) ?? []), w.weekday]);
  return [...groups].sort((a, b) => Math.min(...a[1]) - Math.min(...b[1]))
    .map(([hours, days]) => `${[...new Set(days)].sort().map((d) => DAYS[d]).join(", ")} ${hours}`).join("; ");
}
/** White or near-black text, whichever reads better on the clinic's chosen colour. */
function onColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.35 ? "#14201c" : "#ffffff";
}

export default async function ClinicSite({ params }: { params: Promise<{ slug: string }> }) {
  const p = await getProfile((await params).slug);
  if (!p) notFound();
  const accent = p.theme_color;
  const tel = (n: string) => `tel:${n.replace(/[^\d+]/g, "")}`;
  const consultations = p.services.filter((s) => s.kind === "consultation");
  const others = p.services.filter((s) => s.kind !== "consultation");

  return (
    <div className="bg-surface">
      {p.announcements.length ? (
        <div className="px-4 py-2 text-center text-sm" style={{ background: accent, color: onColor(accent) }}>
          {p.announcements.map((a) => <p key={a.title}><strong>{a.title}</strong>{a.body ? ` ${a.body}` : ""}</p>)}
        </div>
      ) : null}

      <header className="border-b border-line">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid size-11 place-items-center rounded-panel text-lg font-bold" style={{ background: accent, color: onColor(accent) }} aria-hidden>{p.name.charAt(0)}</span>
            <p className="text-lg font-semibold leading-tight">{p.name}</p>
          </div>
          {p.phone ? <a href={tel(p.phone)} className="rounded-control px-4 py-2 font-medium" style={{ background: accent, color: onColor(accent) }}>Call {p.phone}</a> : null}
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <h1 className="max-w-3xl text-[2rem] font-semibold leading-tight tracking-[-0.01em]">{p.hero_title}</h1>
        {p.hero_subtitle ? <p className="mt-2 max-w-2xl text-lg text-ink-soft">{p.hero_subtitle}</p> : null}
        <ul className="mt-6 flex flex-wrap gap-x-8 gap-y-2 text-ink-soft">
          {p.address ? <li className="flex items-center gap-2"><Icon name="MapPin" />{p.map_url ? <a className="hover:underline" href={p.map_url} rel="noopener noreferrer" target="_blank">{p.address}</a> : p.address}</li> : null}
          {p.hours ? <li className="flex items-center gap-2"><Icon name="Clock" />{p.hours}</li> : null}
          {p.whatsapp ? <li className="flex items-center gap-2"><Icon name="Phone" /><a className="hover:underline" href={`https://wa.me/${p.whatsapp.replace(/\D/g, "")}`} rel="noopener noreferrer" target="_blank">WhatsApp {p.whatsapp}</a></li> : null}
          {p.email ? <li className="flex items-center gap-2"><a className="hover:underline" href={`mailto:${p.email}`}>{p.email}</a></li> : null}
        </ul>
      </section>

      {p.doctors.length ? (
        <section aria-labelledby="doctors" className="mx-auto max-w-5xl px-4 pb-12 sm:px-6">
          <h2 id="doctors" className="text-[1.5rem] font-semibold">Our doctors</h2>
          <ul className="mt-5 divide-y divide-line border-y border-line">
            {p.doctors.map((d) => (
              <li key={d.id} className="grid gap-x-6 gap-y-1 py-4 sm:grid-cols-[1.4fr_1fr_auto] sm:items-start">
                <div>
                  <p className="font-semibold">{d.name}</p>
                  {d.specialty || d.qualification ? <p className="text-sm text-ink-soft">{[d.specialty, d.qualification].filter(Boolean).join(", ")}</p> : null}
                  {d.registration ? <p className="text-sm text-ink-faint">{d.registration}</p> : null}
                  {d.bio ? <p className="mt-1 max-w-prose text-sm text-ink-soft">{d.bio}</p> : null}
                </div>
                <p className="text-ink-soft">{opdText(d.opd) ?? "Call for OPD times"}</p>
                {d.fee !== null ? <p className="font-medium tabular-nums sm:text-right">{npr(d.fee)}</p> : <span />}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {p.services.length ? (
        <section aria-labelledby="services" className="mx-auto max-w-5xl px-4 pb-12 sm:px-6">
          <h2 id="services" className="text-[1.5rem] font-semibold">Services</h2>
          <dl className="mt-5 grid max-w-2xl grid-cols-[1fr_auto] gap-x-6 gap-y-2">
            {[...consultations, ...others].map((s) => (
              <div key={s.name} className="contents"><dt>{s.name}</dt><dd className="text-right tabular-nums text-ink-soft">{s.price !== null ? npr(s.price) : ""}</dd></div>
            ))}
          </dl>
        </section>
      ) : null}

      {p.about ? (
        <section aria-labelledby="about" className="border-t border-line bg-canvas">
          <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
            <h2 id="about" className="text-[1.5rem] font-semibold">About us</h2>
            <div className="mt-3 max-w-prose space-y-3 text-ink-soft">{p.about.split(/\n\s*\n/).map((para, i) => <p key={i} className="whitespace-pre-line">{para}</p>)}</div>
            {p.departments.length ? <p className="mt-4 text-ink-soft">Departments: {p.departments.map((d) => d.name).join(", ")}</p> : null}
          </div>
        </section>
      ) : null}

      {p.faqs.length ? (
        <section aria-labelledby="faq" className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
          <h2 id="faq" className="text-[1.5rem] font-semibold">Questions</h2>
          <div className="mt-4 max-w-prose divide-y divide-line border-y border-line">
            {p.faqs.map((f) => (
              <details key={f.q} className="py-3"><summary className="cursor-pointer font-medium">{f.q}</summary><p className="mt-2 whitespace-pre-line text-ink-soft">{f.a}</p></details>
            ))}
          </div>
        </section>
      ) : null}

      <section id="book" className="border-t border-line">
        <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
          <h2 className="text-[1.5rem] font-semibold">Book an appointment</h2>
          <p className="mt-2 text-ink-soft">
            {p.phone ? <>Call <a className="font-medium underline" href={tel(p.phone)}>{p.phone}</a> to book. </> : null}Online booking is coming soon.
          </p>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto max-w-5xl px-4 py-6 text-sm text-ink-faint sm:px-6">{p.name}. Website by CMediSewa.</div>
      </footer>
    </div>
  );
}
