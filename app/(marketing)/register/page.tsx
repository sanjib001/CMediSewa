import Link from "next/link";
import { serviceClient } from "@/lib/supabase/service";
import { RegisterForm } from "@/components/platform/register-form";
import { getPlatformSettings } from "@/lib/platform/settings";

export const metadata = { title: "Register your clinic" };
export const dynamic = "force-dynamic";

// W-01 step 1: a clinic registers; the platform reviews and approves (D-29).
export default async function Register({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const { plan } = await searchParams;
  const { data } = await serviceClient().from("plans").select("id, name").eq("is_public", true).eq("is_active", true).order("sort_order").order("price_npr");
  const plans = (data ?? []) as { id: string; name: string }[];
  const settings = await getPlatformSettings();
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-5 sm:px-6">
        <Link href="/" className="text-xl font-semibold">CMediSewa</Link>
        <Link href="/login" className="text-ink-soft hover:text-ink">Sign in</Link>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        <h1 className="text-[2rem] font-semibold leading-tight">Register your clinic</h1>
        <p className="mt-2 max-w-xl text-ink-soft">
          Tell us about your clinic. We review every registration and call you before setting it up. Your clinic comes with
          registrar, OPD, pharmacy and admin dashboards.
        </p>
        {settings.registrations_open
          ? <div className="mt-8"><RegisterForm plans={plans} defaultPlan={plans.some((p) => p.id === plan) ? plan : undefined} /></div>
          : <p className="mt-8 rounded-panel border border-line bg-surface p-5">We aren&apos;t taking new registrations right now. <Link href="/contact" className="text-pine underline">Contact us</Link> and we&apos;ll let you know when we open again.</p>}
      </main>
    </div>
  );
}
