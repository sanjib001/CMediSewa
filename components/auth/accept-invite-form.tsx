"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptInvite } from "@/app/actions/invite";
import { Button } from "@/components/ui/primitives";
import { authInput } from "./auth-frame";

export function AcceptInviteForm({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setError(null);
        start(async () => {
          const r = await acceptInvite({ token, password: String(f.get("password")), confirm: String(f.get("confirm")) });
          if (r.ok) { router.replace(r.redirectTo); router.refresh(); } else setError(r.error);
        });
      }}
    >
      <label className="block"><span className="mb-1 block text-sm font-medium">Email</span>
        <input value={email} readOnly autoComplete="username" className={`${authInput} bg-sunken`} /></label>
      <label className="block"><span className="mb-1 block text-sm font-medium">Choose a password</span>
        <input name="password" type="password" minLength={10} required autoComplete="new-password" className={authInput} />
        <span className="mt-1 block text-xs text-ink-faint">At least 10 characters.</span></label>
      <label className="block"><span className="mb-1 block text-sm font-medium">Repeat password</span>
        <input name="confirm" type="password" minLength={10} required autoComplete="new-password" className={authInput} /></label>
      {error ? <p role="alert" className="rounded-control bg-alert-tint px-3 py-2 text-sm text-alert">{error}</p> : null}
      <Button type="submit" className="w-full" disabled={pending}>{pending ? "Setting up…" : "Create my account"}</Button>
      <p className="text-sm text-ink-faint">Next you&apos;ll set up an authenticator app. Clinic admins need it to sign in.</p>
    </form>
  );
}
