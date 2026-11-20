"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { createClinic, type CreateClinicResult } from "@/app/actions/platform";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

const field = "w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-ink placeholder:text-ink-faint";
const lbl = "mb-1 block text-sm font-medium";
const toSlug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, "").trim().replace(/[\s-]+/g, "-").slice(0, 40).replace(/-$/, "");

function CopyRow({ label, value, note }: { label: string; value: string; note: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-control bg-sunken px-3 py-2 text-sm">{value}</code>
        <button type="button" className="rounded-control border border-line-strong px-3 py-2 text-sm hover:bg-sunken"
          onClick={() => navigator.clipboard.writeText(value).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <p className="text-xs text-ink-faint">{note}</p>
    </div>
  );
}

/** Super Admin → Clinics → Add a clinic (HRestroSewa's "New restaurant"): the clinic and its
 *  admin are created at once; the admin finishes with a one-time setup link. */
export function CreateClinicForm({ plans, today }: { plans: { id: string; name: string; billing_cycle_days: number }[]; today: string }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [source, setSource] = useState("trial");
  const [result, setResult] = useState<Extract<CreateClinicResult, { ok: true }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (result) {
    return (
      <div role="status" className="space-y-5 rounded-panel border border-ok bg-surface p-6">
        <p className="text-lg font-semibold">{name} is created</p>
        <p className="text-ink-soft">Send the setup link to the clinic admin (WhatsApp, Viber or in person). It works once and expires in 7 days. After that they always sign in at the clinic&apos;s own address.</p>
        <CopyRow label="1. One-time setup link (for the clinic admin)" value={result.setupLink} note="Shown only now. If it's lost or expires, make a new one on the clinic's page." />
        <CopyRow label="2. Clinic sign-in address (for the admin and all staff, every day)" value={result.signInLink} note="Bookmark this on the clinic's computers." />
        <div className="flex flex-wrap gap-2">
          <Link href={`/superadmin/tenants/${result.tenantId}`} className="rounded-control bg-pine px-4 py-2 font-medium text-white">Open the clinic</Link>
          <button type="button" className="rounded-control border border-line-strong px-4 py-2" onClick={() => { setResult(null); setName(""); setSlug(""); setSlugTouched(false); }}>Create another</button>
        </div>
      </div>
    );
  }

  return (
    <form className="space-y-6" onSubmit={(e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
      setError(null);
      start(async () => {
        const r = await createClinic({
          name, slug, ownerName: f.owner_name ?? "", ownerEmail: f.owner_email ?? "", phone: f.phone ?? "", district: f.district, municipality: f.municipality, pan: f.pan,
          planId: f.plan_id ?? "", startsOn: f.starts_on ?? today, periodDays: Number(f.period_days), source,
        });
        if (r.ok) setResult(r); else setError(r.error);
      });
    }}>
      <section className="grid gap-3 rounded-panel border border-line bg-surface p-5 sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Clinic</h2>
        <label className="block"><span className={lbl}>Clinic name</span>
          <input value={name} required onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(toSlug(e.target.value)); }} placeholder="e.g. Sunrise Clinic & Pharmacy" className={field} /></label>
        <label className="block"><span className={lbl}>Clinic link</span>
          <div className="flex items-center rounded-control border border-line-strong bg-surface">
            <span className="pl-3 text-sm text-ink-faint">/c/</span>
            <input value={slug} required onChange={(e) => { setSlug(e.target.value.toLowerCase()); setSlugTouched(true); }} pattern="[a-z0-9][a-z0-9-]{0,48}[a-z0-9]" className="w-full rounded-control bg-transparent px-1 py-2" />
          </div>
          <span className="mt-1 block text-xs text-ink-faint">Its website and staff sign-in use this. Can&apos;t be changed later.</span></label>
        <label className="block"><span className={lbl}>Phone</span><input name="phone" required type="tel" className={field} /></label>
        <label className="block"><span className={lbl}>PAN (optional)</span><input name="pan" inputMode="numeric" pattern="\d{9}" className={field} /></label>
        <label className="block"><span className={lbl}>District</span><input name="district" className={field} /></label>
        <label className="block"><span className={lbl}>Municipality</span><input name="municipality" className={field} /></label>
      </section>

      <section className="grid gap-3 rounded-panel border border-line bg-surface p-5 sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Clinic admin <span className="font-normal text-ink-faint">(created now; signs in with this email)</span></h2>
        <label className="block"><span className={lbl}>Name</span><input name="owner_name" required className={field} /></label>
        <label className="block"><span className={lbl}>Email</span><input name="owner_email" required type="email" className={field} /></label>
      </section>

      <section className="grid gap-3 rounded-panel border border-line bg-surface p-5 sm:grid-cols-4">
        <h2 className="font-semibold sm:col-span-4">Subscription</h2>
        <label className="block sm:col-span-2"><span className={lbl}>Plan</span>
          <select name="plan_id" required className={field}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="block"><span className={lbl}>Starts</span><input name="starts_on" type="date" defaultValue={today} className={field} /></label>
        <label className="block"><span className={lbl}>Days</span><input name="period_days" type="number" min={1} max={1100} defaultValue={source === "trial" ? 30 : 365} key={source} className={field} /></label>
        <fieldset className="sm:col-span-4"><legend className={lbl}>Type</legend>
          <div className="flex flex-wrap gap-2">{[["trial", "Free trial"], ["paid", "Paid"], ["complimentary", "Complimentary"]].map(([v, l]) => (
            <label key={v} className={cn("cursor-pointer rounded-control border px-3 py-1.5 text-sm", source === v ? "border-pine bg-pine-tint font-medium text-pine-deep" : "border-line-strong")}>
              <input type="radio" name="source" value={v} checked={source === v} onChange={() => setSource(v!)} className="sr-only" />{l}</label>))}</div>
        </fieldset>
      </section>

      {error ? <p role="alert" className="rounded-control bg-alert-tint px-3 py-2 text-sm text-alert">{error}</p> : null}
      <Button type="submit" disabled={pending || !plans.length}>{pending ? "Creating…" : "Create clinic and its admin"}</Button>
      {!plans.length ? <p className="text-sm text-warn">Create a plan first in Plans &amp; billing.</p> : null}
    </form>
  );
}
