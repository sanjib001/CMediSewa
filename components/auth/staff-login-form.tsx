"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signInStaff } from "@/app/actions/staff-auth";
import { Button } from "@/components/ui/primitives";
import { authInput } from "./auth-frame";

/** L2/L3: email (or, on a clinic link, username) + password. */
export function StaffLoginForm({ slug, notice }: { slug?: string; notice?: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(notice ?? null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    start(async () => {
      const res = await signInStaff({ login: String(f.get("login")), password: String(f.get("password")), slug: slug ?? null });
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
        <span className="mb-1 block text-sm font-medium">{slug ? "Email or username" : "Email"}</span>
        <input name="login" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required className={authInput} />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Password</span>
        <input name="password" type="password" autoComplete="current-password" required className={authInput} />
      </label>
      {error ? <p role="alert" className="rounded-control bg-alert-tint px-3 py-2 text-sm text-alert">{error}</p> : null}
      <Button type="submit" className="w-full" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</Button>
    </form>
  );
}
