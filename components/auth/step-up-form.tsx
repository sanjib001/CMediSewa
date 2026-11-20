"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { stepUpPassword } from "@/app/actions/staff-auth";
import { Button } from "@/components/ui/primitives";
import { authInput } from "./auth-frame";

/** L6: confirm it's you. Raises THIS session's level; it never opens a second session. */
export function StepUpForm({ next }: { next: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    setError(null);
    start(async () => {
      const res = await stepUpPassword({ password, next });
      if (res.ok) {
        router.replace(res.redirectTo);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Password</span>
        <input name="password" type="password" autoComplete="current-password" required autoFocus className={authInput} />
      </label>
      {error ? <p role="alert" className="rounded-control bg-alert-tint px-3 py-2 text-sm text-alert">{error}</p> : null}
      <Button type="submit" className="w-full" disabled={pending}>{pending ? "Checking…" : "Continue"}</Button>
    </form>
  );
}
