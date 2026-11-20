"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { pinSignIn } from "@/app/actions/staff-auth";
import { Icon } from "@/components/ui/icon";
import { StaffLoginForm } from "./staff-login-form";
import { cn } from "@/lib/cn";

type Staff = { member_id: string; display_name: string; title: string | null };
const PIN_LENGTH = 6;

/**
 * Clinic-link sign-in (L3/L4). The server decides `trusted` from the device cookie; an
 * untrusted device never receives the staff list at all (closes HRestroSewa's gap).
 */
export function PinSignIn({ slug, trusted, staff }: { slug: string; trusted: boolean; staff: Staff[] }) {
  const router = useRouter();
  const [usePassword, setUsePassword] = useState(!trusted || staff.length === 0);
  const [who, setWho] = useState<Staff | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(fullPin: string) {
    if (!who) return;
    setError(null);
    start(async () => {
      const res = await pinSignIn({ slug, memberId: who.member_id, pin: fullPin });
      if (res.ok) {
        router.replace(res.redirectTo);
        router.refresh();
      } else {
        setError(res.error);
        setPin("");
      }
    });
  }
  const press = (d: string) => {
    if (pending) return;
    const next = pin.length < PIN_LENGTH ? pin + d : pin;
    setPin(next);
    if (next.length === PIN_LENGTH) submit(next);
  };

  if (usePassword) {
    return (
      <div>
        <StaffLoginForm slug={slug} />
        {trusted && staff.length > 0 ? (
          <button type="button" onClick={() => setUsePassword(false)} className="mt-4 text-sm text-pine hover:underline">Use my PIN instead</button>
        ) : (
          <p className="mt-4 text-sm text-ink-faint">Quick PIN sign-in works only on devices your clinic admin has trusted.</p>
        )}
      </div>
    );
  }

  if (!who) {
    return (
      <div>
        <p className="mb-3 font-medium">Who&apos;s signing in?</p>
        <ul className="grid grid-cols-2 gap-2">
          {staff.map((s) => (
            <li key={s.member_id}>
              <button type="button" onClick={() => { setWho(s); setPin(""); setError(null); }} className="w-full rounded-control border border-line px-3 py-3 text-left hover:border-pine hover:bg-pine-tint">
                <span className="block font-medium leading-tight">{s.display_name}</span>
                {s.title ? <span className="text-sm text-ink-faint">{s.title}</span> : null}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => setUsePassword(true)} className="mt-4 text-sm text-pine hover:underline">Use email or username and password</button>
      </div>
    );
  }

  return (
    <div>
      <button type="button" onClick={() => { setWho(null); setPin(""); setError(null); }} className="mb-3 text-sm text-pine hover:underline">Not {who.display_name.split(" ")[0]}? Choose again</button>
      <p className="font-medium">{who.display_name}</p>
      <p className="mb-4 text-sm text-ink-faint">Enter your 6-digit PIN</p>
      <div className="mb-5 flex justify-center gap-2.5" aria-live="polite" aria-label={`${pin.length} of ${PIN_LENGTH} digits entered`}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} className={cn("size-3.5 rounded-full border-2", i < pin.length ? "border-pine bg-pine" : "border-line-strong")} />
        ))}
      </div>
      <div className="mx-auto grid max-w-64 grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" disabled={pending} onClick={() => press(d)} className="h-14 rounded-control bg-sunken text-xl font-semibold hover:bg-pine-tint disabled:opacity-50">{d}</button>
        ))}
        <span />
        <button type="button" disabled={pending} onClick={() => press("0")} className="h-14 rounded-control bg-sunken text-xl font-semibold hover:bg-pine-tint disabled:opacity-50">0</button>
        <button type="button" disabled={pending} onClick={() => setPin((p) => p.slice(0, -1))} className="grid h-14 place-items-center rounded-control text-ink-soft hover:bg-sunken" aria-label="Delete digit">
          <Icon name="Delete" className="size-5" />
        </button>
      </div>
      {pending ? <p className="mt-4 text-center text-sm text-ink-soft">Checking…</p> : null}
      {error ? <p role="alert" className="mt-4 rounded-control bg-alert-tint px-3 py-2 text-center text-sm text-alert">{error}</p> : null}
      <p className="mt-4 text-center text-sm text-ink-faint">A PIN opens front-desk and counter work. Patient records and admin screens ask for your password.</p>
    </div>
  );
}
