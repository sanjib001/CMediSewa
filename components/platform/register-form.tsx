"use client";

import { useState, useTransition } from "react";
import { submitRegistration } from "@/app/actions/registration";
import { Button } from "@/components/ui/primitives";
import { field, label } from "./action-form";

export function RegisterForm({ plans, defaultPlan }: { plans: { id: string; name: string }[]; defaultPlan?: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <div role="status" className="rounded-panel border border-line bg-surface p-6">
        <p className="text-lg font-semibold">Thank you. We&apos;ve received your registration.</p>
        <p className="mt-2 text-ink-soft">We&apos;ll call you on the number you gave to confirm a few details. Once approved, you&apos;ll get a link to set up your clinic.</p>
      </div>
    );
  }
  return (
    <form
      className="space-y-4 rounded-panel border border-line bg-surface p-6"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setError(null);
        start(async () => {
          const r = await submitRegistration(fd);
          if (r.ok) setDone(true); else setError(r.error);
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2"><span className={label}>Clinic name</span><input name="business_name" required maxLength={120} className={field} /></label>
        <label className="block"><span className={label}>Owner or manager</span><input name="owner_name" required maxLength={80} autoComplete="name" className={field} /></label>
        <label className="block"><span className={label}>Phone</span><input name="phone" required inputMode="tel" autoComplete="tel" placeholder="98XXXXXXXX" className={field} /></label>
        <label className="block sm:col-span-2"><span className={label}>Email</span><input name="email" type="email" required autoComplete="email" className={field} />
          <span className="mt-1 block text-xs text-ink-faint">The clinic admin signs in with this email.</span></label>
        <label className="block"><span className={label}>District</span><input name="district" className={field} /></label>
        <label className="block"><span className={label}>Municipality</span><input name="municipality" className={field} /></label>
        <label className="block"><span className={label}>PAN (optional)</span><input name="pan" inputMode="numeric" className={field} /></label>
        {plans.length ? (
          <label className="block"><span className={label}>Plan you&apos;re interested in</span>
            <select name="plan_id" defaultValue={defaultPlan ?? ""} className={field}>
              <option value="">Not sure yet</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
        ) : null}
        <label className="block sm:col-span-2"><span className={label}>Anything we should know? (optional)</span><textarea name="message" rows={3} maxLength={1000} className={field} /></label>
      </div>
      {/* Honeypot: hidden from people, irresistible to bots. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
      </div>
      <label className="flex items-start gap-2 text-[0.95rem]"><input type="checkbox" name="consent" required className="mt-1" />
        <span>CMediSewa may contact me by phone or email about this registration.</span></label>
      {error ? <p role="alert" className="rounded-control bg-alert-tint px-3 py-2 text-sm text-alert">{error}</p> : null}
      <Button type="submit" disabled={pending}>{pending ? "Sending…" : "Send registration"}</Button>
    </form>
  );
}
