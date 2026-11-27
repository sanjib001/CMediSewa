import { cache } from "react";
import { notFound } from "next/navigation";
import { serviceClient } from "@/lib/supabase/service";
import { Icon } from "@/components/ui/icon";
import { BookingForm } from "@/components/public/booking-form";
import { adToBs, formatBs, localDate } from "@/lib/clinic-time";
import { cn } from "@/lib/cn";

// The clinic's public website (U7, D-34; redesigned D-156). Everything shown comes from
// public_clinic_profile(): an allow-list of fields, only for an ACTIVE clinic with a PUBLISHED
// site, and only doctors with a verified registration. No other table is read here. Content is
// plain text: React escapes it, and no HTML from the clinic is ever rendered.
// What patients come to check leads the page: who sits in OPD today, when, the fee, and Book.

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
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const npr = (n: number) => `Rs. ${Number(n).toLocaleString("en-IN")}`;
const hm = (t: string) => t.slice(0, 5);

/** White or near-black text, whichever reads better on the clinic's chosen colour. */
function onColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.35 ? "#14201c" : "#ffffff";
}
type Doc = Profile["doctors"][number];
const windowsOn = (d: Doc, wd: number) => (d.opd ?? []).filter((w) => w.weekday === wd).sort((a, b) => a.start.localeCompare(b.start));

export default async function ClinicSite({ params }: { params: Promise<{ slug: string }> }) {
  const p = await getProfile((await params).slug);
  if (!p) notFound();
  const accent = p.theme_color;
  const on = onColor(accent);
  const tel = (n: string) => `tel:${n.replace(/[^\d+]/g, "")}`;
  const consultations = p.services.filter((s) => s.kind === "consultation");
  const others = p.services.filter((s) => s.kind !== "consultation");
  const canBook = p.booking_enabled && p.doctors.length > 0;
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(now);
  const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
  const bs = formatBs(adToBs(localDate(now))).split(" ");       // [year, month, day]
  const sittingToday = p.doctors.filter((d) => windowsOn(d, wd).length > 0);
  // When nobody sits today: the next day someone does.
  const next = sittingToday.length ? null : [1, 2, 3, 4, 5, 6].map((k) => (wd + k) % 7).find((d) => p.doctors.some((x) => windowsOn(x, d).length));

  return (
    <div className="bg-surface pb-20 sm:pb-0" style={{ ["--accent" as string]: accent, ["--on-accent" as string]: on }}>
      {p.announcements.length ? (
        <div className="px-4 py-2 text-center text-sm" style={{ background: accent, color: on }}>
          {p.announcements.map((a) => <p key={a.title}><strong>{a.title}</strong>{a.body ? ` ${a.body}` : ""}</p>)}
        </div>
      ) : null}

      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <a href="#top" className="flex min-w-0 items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-control text-lg font-bold" style={{ background: accent, color: on }} aria-hidden>{p.name.charAt(0)}</span>
            <span className="truncate text-lg font-semibold leading-tight">{p.name}</span>
          </a>
          <nav className="flex shrink-0 items-center gap-2" aria-label="Contact">
            {p.phone ? <a href={tel(p.phone)} className="hidden rounded-control border border-line-strong px-4 py-2 font-medium sm:inline-flex">Call {p.phone}</a> : null}
            {canBook ? <a href="#book" className="hidden rounded-control px-4 py-2 font-medium sm:inline-flex" style={{ background: accent, color: on }}>Book appointment</a> : null}
            {p.phone ? <a href={tel(p.phone)} className="rounded-control border border-line-strong px-3 py-2 font-medium sm:hidden" aria-label={`Call ${p.phone}`}><Icon name="Phone" /></a> : null}
          </nav>
        </div>
      </header>

      <main id="top">
        <section className="mx-auto max-w-5xl px-4 pb-8 pt-8 sm:px-6 sm:pt-12">
          <h1 className="max-w-3xl text-[2rem] font-semibold leading-[1.1] tracking-[-0.015em] sm:text-[2.5rem]">{p.hero_title}</h1>
          {p.hero_subtitle ? <p className="mt-3 max-w-2xl text-lg text-ink-soft">{p.hero_subtitle}</p> : null}

          {/* Who sits today: the first thing patients come to check. Not shown without doctors (a pharmacy-only site). */}
          {p.doctors.length ? <div className="mt-8 rounded-panel border border-line" aria-labelledby="today">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-3" style={{ borderTop: `4px solid ${accent}`, borderTopLeftRadius: "inherit", borderTopRightRadius: "inherit" }}>
              <h2 id="today" className="text-xl font-semibold">{sittingToday.length ? "In OPD today" : "No OPD today"}</h2>
              <p className="text-ink-soft">{DAY_NAMES[wd]}, {bs[1]} {bs[2]}</p>
            </div>
            {sittingToday.length ? (
              <ul className="divide-y divide-line">{sittingToday.map((d) => (
                <li key={d.id} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-4 sm:grid-cols-[1.3fr_auto_auto_auto]">
                  <div className="min-w-0">
                    <p className="text-[1.0625rem] font-semibold">{d.name}</p>
                    {d.specialty ? <p className="text-[0.95rem] text-ink-soft">{d.specialty}</p> : null}
                  </div>
                  <p className="text-right text-[1.35rem] font-semibold leading-tight tabular-nums sm:text-left">
                    {windowsOn(d, wd).map((w) => `${hm(w.start)}–${hm(w.end)}`).join(", ")}
                  </p>
                  <p className="font-medium tabular-nums">{d.fee !== null ? npr(d.fee) : ""}</p>
                  {canBook ? <a href={`#book-${d.id}`} className="justify-self-end rounded-control px-5 py-2.5 font-semibold" style={{ background: accent, color: on }}>Book</a> : <span />}
                </li>))}</ul>
            ) : (
              <p className="px-5 py-4 text-ink-soft">
                {next !== undefined && next !== null
                  ? <>Next OPD on {DAY_NAMES[next]}: {p.doctors.filter((x) => windowsOn(x, next).length).map((x) => `${x.name} ${windowsOn(x, next).map((w) => `${hm(w.start)}–${hm(w.end)}`).join(", ")}`).join("; ")}.</>
                  : "Call the clinic for OPD times."}
                {canBook ? <> You can still <a href="#book" className="font-medium underline">book a later day</a>.</> : null}
              </p>
            )}
          </div> : null}

          <ul className="mt-6 flex flex-wrap gap-x-8 gap-y-2 text-[1.0625rem] text-ink-soft">
            {p.address ? <li className="flex items-center gap-2"><Icon name="MapPin" />{p.map_url ? <a className="hover:underline" href={p.map_url} rel="noopener noreferrer" target="_blank">{p.address}</a> : p.address}</li> : null}
            {p.hours ? <li className="flex items-center gap-2"><Icon name="Clock" />{p.hours}</li> : null}
          </ul>
        </section>

        {p.doctors.length ? (
          <section aria-labelledby="doctors" className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
            <h2 id="doctors" className="text-[1.5rem] font-semibold">Doctors and OPD days</h2>
            <ul className="mt-5 space-y-6">
              {p.doctors.map((d) => (
                <li key={d.id} className="border-t border-line pt-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <div>
                      <p className="text-xl font-semibold">{d.name}</p>
                      <p className="text-[1.0625rem] text-ink-soft">{[d.specialty, d.qualification].filter(Boolean).join(", ")}</p>
                      {d.registration ? <p className="text-[0.95rem] text-ink-soft">{d.registration}</p> : null}
                    </div>
                    {d.fee !== null ? <p className="text-lg font-semibold tabular-nums">Fee {npr(d.fee)}</p> : null}
                  </div>
                  {d.bio ? <p className="mt-2 max-w-prose text-[1.0625rem] text-ink-soft">{d.bio}</p> : null}
                  {/* The week as a strip, Sunday first as in Nepal; today is outlined. */}
                  <ol className="mt-4 grid grid-cols-1 gap-1.5 sm:grid-cols-7 sm:text-center" aria-label={`${d.name}'s OPD days`}>
                    {DAYS.map((name, i) => {
                      const ws = windowsOn(d, i);
                      return (
                        <li key={name} className="flex items-baseline justify-between gap-3 rounded-control px-3 py-2.5 sm:block sm:px-1" aria-current={i === wd ? "date" : undefined}
                          style={ws.length ? { background: `color-mix(in srgb, ${accent} 12%, white)`, boxShadow: i === wd ? `inset 0 0 0 2px ${accent}` : undefined } : { background: "var(--color-sunken)", boxShadow: i === wd ? "inset 0 0 0 2px var(--color-line-strong)" : undefined }}>
                          <span className="block font-semibold">{name}{i === wd ? <span className="font-normal text-ink-soft sm:hidden">, today</span> : null}</span>
                          <span className={cn("block text-[0.95rem] leading-snug tabular-nums", ws.length ? "text-ink" : "text-ink-soft")}>
                            {ws.length ? ws.map((w) => <span key={w.start} className="block">{hm(w.start)}–{hm(w.end)}</span>) : "No OPD"}</span>
                        </li>
                      );
                    })}
                  </ol>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {p.services.length ? (
          <section aria-labelledby="services" className="border-t border-line bg-canvas">
            <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
              <h2 id="services" className="text-[1.5rem] font-semibold">Services and prices</h2>
              <dl className="mt-5 grid gap-x-12 text-[1.0625rem] md:grid-cols-2">
                {[...consultations, ...others].map((s) => (
                  <div key={s.name} className="flex justify-between gap-6 border-b border-line py-3"><dt>{s.name}</dt><dd className="font-medium tabular-nums">{s.price !== null ? npr(s.price) : ""}</dd></div>
                ))}
              </dl>
            </div>
          </section>
        ) : null}

        <section aria-labelledby="visit" className="mx-auto grid max-w-5xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-2">
          <div>
            <h2 id="visit" className="text-[1.5rem] font-semibold">Visit us</h2>
            <dl className="mt-4 space-y-4 text-[1.0625rem]">
              {p.address ? <div><dt className="text-[0.95rem] text-ink-soft">Address</dt><dd>{p.map_url ? <a className="underline" href={p.map_url} rel="noopener noreferrer" target="_blank">{p.address}, open the map</a> : p.address}</dd></div> : null}
              {p.hours ? <div><dt className="text-[0.95rem] text-ink-soft">Opening hours</dt><dd>{p.hours}</dd></div> : null}
              {p.phone ? <div><dt className="text-[0.95rem] text-ink-soft">Phone</dt><dd><a className="underline" href={tel(p.phone)}>{p.phone}</a></dd></div> : null}
              {p.whatsapp ? <div><dt className="text-[0.95rem] text-ink-soft">WhatsApp</dt><dd><a className="underline" href={`https://wa.me/${p.whatsapp.replace(/\D/g, "")}`} rel="noopener noreferrer" target="_blank">{p.whatsapp}</a></dd></div> : null}
              {p.email ? <div><dt className="text-[0.95rem] text-ink-soft">Email</dt><dd><a className="underline" href={`mailto:${p.email}`}>{p.email}</a></dd></div> : null}
            </dl>
          </div>
          {p.about ? (
            <div>
              <h2 className="text-[1.5rem] font-semibold">About us</h2>
              <div className="mt-4 max-w-prose space-y-3 text-[1.0625rem] text-ink-soft">{p.about.split(/\n\s*\n/).map((para, i) => <p key={i} className="whitespace-pre-line">{para}</p>)}</div>
              {p.departments.length ? <p className="mt-4 text-[1.0625rem] text-ink-soft">Departments: {p.departments.map((d) => d.name).join(", ")}</p> : null}
            </div>
          ) : null}
        </section>

        {p.faqs.length ? (
          <section aria-labelledby="faq" className="border-t border-line">
            <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
              <h2 id="faq" className="text-[1.5rem] font-semibold">Questions</h2>
              <div className="mt-4 max-w-prose divide-y divide-line border-y border-line">
                {p.faqs.map((f) => (
                  <details key={f.q} className="py-4"><summary className="cursor-pointer text-[1.0625rem] font-semibold">{f.q}</summary><p className="mt-2 whitespace-pre-line text-[1.0625rem] text-ink-soft">{f.a}</p></details>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        <section id="book" className="scroll-mt-20 border-t border-line bg-canvas">
          <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
            <h2 className="text-[1.5rem] font-semibold">Book an appointment</h2>
            {canBook ? (
              <>
                <p className="mb-6 mt-2 max-w-2xl text-ink-soft">Choose a doctor and a time and send a request. The clinic will call or email you to confirm{p.phone ? <>, or call <a className="font-medium underline" href={tel(p.phone)}>{p.phone}</a></> : null}.</p>
                <BookingForm slug={p.slug} today={today} accent={accent} onAccent={on}
                  doctors={p.doctors.map((d) => ({ id: d.id, name: d.name, specialty: d.specialty, fee: d.fee, weekdays: DAYS.map((_, i) => i).filter((i) => windowsOn(d, i).length > 0) }))} />
              </>
            ) : (
              <p className="mt-2 text-ink-soft">{p.phone ? <>Call <a className="font-medium underline" href={tel(p.phone)}>{p.phone}</a> to book.</> : "Please contact the clinic to book."}</p>
            )}
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto max-w-5xl px-4 pb-24 pt-6 text-[0.95rem] text-ink-soft sm:px-6 sm:pb-6">{p.name}. Website by CMediSewa.</div>
      </footer>

      {/* Phones: calling and booking stay one tap away. */}
      {p.phone || canBook ? (
        <nav aria-label="Call or book" className="fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t border-line bg-surface p-3 sm:hidden">
          {p.phone ? <a href={tel(p.phone)} className="flex-1 rounded-control border border-line-strong py-3 text-center font-semibold">Call</a> : null}
          {canBook ? <a href="#book" className="flex-[2] rounded-control py-3 text-center font-semibold" style={{ background: accent, color: on }}>Book appointment</a> : null}
        </nav>
      ) : null}
    </div>
  );
}
