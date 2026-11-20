"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signInSuperAdmin } from "@/app/actions/superadmin-auth";
import { Button } from "@/components/ui/primitives";
import { authInput } from "./auth-frame";

// Controlled submit + useTransition, with the redirect done on the client from the action's
// result (HRestroSewa lesson: redirect detection via useActionState was unreliable).
export function SuperAdminLoginForm({ denied }: { denied: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(denied ? "This account does not have platform access." : null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError(null);
    start(async () => {
      const res = await signInSuperAdmin({ email: String(form.get("email")), password: String(form.get("password")) });
      if (res.ok) {
        router.replace(res.redirectTo);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Email</span>
        <input name="email" type="email" autoComplete="username" required className={authInput} />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Password</span>
        <input name="password" type="password" autoComplete="current-password" required className={authInput} />
      </label>
      {error ? <p role="alert" className="rounded-control bg-alert-tint px-3 py-2 text-sm text-alert">{error}</p> : null}
      <Button type="submit" className="w-full" disabled={pending}>{pending ? "Signing in…" : "Continue"}</Button>
      <p className="text-sm text-ink-faint">Next you&apos;ll be asked for the code from your authenticator app.</p>
    </form>
  );
}
