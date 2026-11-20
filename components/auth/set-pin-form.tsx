"use client";

import { useState, useTransition } from "react";
import { setMyPin } from "@/app/actions/staff-auth";
import { Button } from "@/components/ui/primitives";
import { authInput } from "./auth-frame";

export function SetPinForm({ hasPin }: { hasPin: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const pin = String(f.get("pin") ?? "");
    if (pin !== String(f.get("confirm") ?? "")) { setMsg({ ok: false, text: "The two PINs don't match." }); return; }
    const form = e.currentTarget;
    setMsg(null);
    start(async () => {
      const res = await setMyPin({ pin });
      if (res.ok) { form.reset(); setMsg({ ok: true, text: "PIN saved. Use it on your clinic's trusted devices." }); }
      else setMsg({ ok: false, text: res.error });
    });
  }
  return (
    <form onSubmit={onSubmit} className="max-w-sm space-y-4">
      <p className="text-ink-soft">{hasPin ? "Change your 6-digit PIN." : "Choose a 6-digit PIN for quick sign-in on trusted devices."}</p>
      {(["pin", "confirm"] as const).map((n) => (
        <label key={n} className="block">
          <span className="mb-1 block text-sm font-medium">{n === "pin" ? "New PIN" : "Repeat PIN"}</span>
          <input name={n} type="password" inputMode="numeric" pattern="\d{6}" maxLength={6} required autoComplete="new-password"
            className={`${authInput} tracking-[0.4em]`} />
        </label>
      ))}
      {msg ? <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-ok" : "text-alert"}>{msg.text}</p> : null}
      <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save PIN"}</Button>
    </form>
  );
}
