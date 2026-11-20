import Link from "next/link";
import { ButtonLink } from "@/components/ui/primitives";
import { OpdTicket } from "@/components/ui/opd-ticket";
import { serviceClient } from "@/lib/supabase/service";

export const metadata = { title: { absolute: "CMediSewa · Clinic and pharmacy management for Nepal" } };

// The patient's day at a clinic IS a sequence, so the steps are numbered.
const JOURNEY = [
  { title: "Registrar", body: "Finds or registers the patient, takes the OPD fee and prints the token, in one step." },
  { title: "Doctor (OPD)", body: "Calls the next token, writes the consultation and sends the prescription straight to the pharmacy." },
  { title: "Pharmacy", body: "Dispenses from tracked batches, earliest expiry first, and bills it. Stock updates as it sells." },
  { title: "Admin", body: "Sees the day's patients, sales, cash and online receipts, dues, and what stock to reorder." },
];

const NEPAL = [
  "Bikram Sambat dates beside AD, and the Nepali fiscal year for bill numbers",
  "Nepali and English names side by side",
  "Rupees, cash and online wallets, split payments",
  "Works on the reception PC, a tablet at the counter, or a phone",
];

// Public plans are read live from the platform's plans (Super Admin → Plans & billing).
// The page is pre-rendered at build time; a build without database access (CI) renders it
// without plans instead of failing, and the 5-minute revalidation fills them in when served.
async function publicPlans() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return [];
  const { data } = await serviceClient().from("plans")
    .select("id, name, description, price_npr, billing_cycle_days, features")
    .eq("is_public", true).eq("is_active", true).order("sort_order").order("price_npr");
  return (data ?? []) as { id: string; name: string; description: string | null; price_npr: number; billing_cycle_days: number; features: string[] }[];
}

export const revalidate = 300;

export default async function MarketingHome() {
  const plans = await publicPlans();
  return (
    <div className="bg-surface">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <span className="text-xl font-semibold">CMediSewa</span>
        <nav className="flex items-center gap-2 text-[0.95rem]">
          <a href="#pricing" className="hidden rounded-control px-3 py-2 text-ink-soft hover:text-ink sm:block">Pricing</a>
          <Link href="/login" className="rounded-control px-3 py-2 text-ink-soft hover:text-ink">Sign in</Link>
          <ButtonLink href="/register">Register your clinic</ButtonLink>
        </nav>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-10 sm:px-6 lg:grid-cols-[1.2fr_1fr] lg:pt-16">
        <div>
          <h1 className="text-[2.5rem] font-semibold leading-[1.08] tracking-[-0.02em] sm:text-[3.25rem]">
            Your clinic and its pharmacy, run from one system.
          </h1>
          <p className="mt-5 max-w-[34rem] text-lg text-ink-soft">
            Registration, OPD tokens, prescriptions, dispensing, stock by batch and expiry, and the day&apos;s accounts.
            Made for clinics in Nepal.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/register">Register your clinic</ButtonLink>
            <ButtonLink href="/c/arogya-demo" tone="secondary">See a clinic website</ButtonLink>
          </div>
        </div>
        <div className="flex justify-center lg:justify-end" aria-hidden>
          <div className="flex rotate-[-3deg] items-end gap-4">
            <OpdTicket token={14} doctor="Dr. Anjali Shrestha" room="Room 2 · General OPD" time="09:05" size="lg" />
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-canvas">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="max-w-xl text-[1.75rem] font-semibold leading-tight">One patient, four desks, no re-typing</h2>
          <ol className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {JOURNEY.map((step, i) => (
              <li key={step.title}>
                <span className="text-sm font-semibold text-pine">{i + 1}</span>
                <h3 className="mt-1 text-lg font-semibold">{step.title}</h3>
                <p className="mt-1.5 text-ink-soft">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2">
        <div>
          <h2 className="text-[1.75rem] font-semibold leading-tight">Built around how clinics here work</h2>
          <ul className="mt-6 space-y-3">
            {NEPAL.map((n) => (
              <li key={n} className="flex gap-3 text-ink-soft"><span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-pine" />{n}</li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="text-[1.75rem] font-semibold leading-tight">Patient records stay private</h2>
          <p className="mt-6 text-ink-soft">
            Each clinic&apos;s data is kept apart from every other clinic&apos;s. Doctors see the patients they treat. A quick PIN opens the counter,
            but a medical record always asks for a password, and every opening is logged.
          </p>
        </div>
      </section>

      <section id="pricing" className="border-t border-line bg-canvas">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-[1.75rem] font-semibold">Pricing</h2>
          <p className="mt-3 max-w-xl text-ink-soft">Every plan includes the registrar, OPD, pharmacy and admin dashboards.</p>
          {plans.length === 0 ? (
            <p className="mt-6 text-ink-soft">Plans will be published here soon. Register now and we&apos;ll call you with pricing.</p>
          ) : (
            <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {plans.map((p) => (
                <li key={p.id} className="flex flex-col rounded-panel border border-line bg-surface p-6">
                  <h3 className="text-lg font-semibold">{p.name}</h3>
                  <p className="mt-2"><span className="text-3xl font-semibold">Rs. {Number(p.price_npr).toLocaleString("en-IN")}</span>
                    <span className="text-ink-soft"> / {p.billing_cycle_days === 365 ? "year" : `${p.billing_cycle_days} days`}</span></p>
                  {p.description ? <p className="mt-2 text-ink-soft">{p.description}</p> : null}
                  {p.features.includes("lab") ? <p className="mt-2 text-sm text-pine">Includes laboratory</p> : null}
                  <div className="mt-auto pt-5"><ButtonLink href={`/register?plan=${p.id}`} tone="secondary" className="w-full">Choose {p.name}</ButtonLink></div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section id="register" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="text-[1.75rem] font-semibold">Register your clinic</h2>
        <p className="mt-3 max-w-xl text-ink-soft">Tell us about your clinic. We review every registration and call you before setting it up.</p>
        <div className="mt-6"><ButtonLink href="/register">Start registration</ButtonLink></div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap justify-between gap-3 px-4 py-6 text-sm text-ink-faint sm:px-6">
          <span>CMediSewa</span>
          <Link href="/login" className="hover:text-ink">Staff sign-in</Link>
        </div>
      </footer>
    </div>
  );
}
