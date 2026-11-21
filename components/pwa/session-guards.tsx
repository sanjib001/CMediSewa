"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { signOutStaff } from "@/app/actions/staff-auth";

const ACTIVE_KEY = "cm_last_active";
const GRACE_S = 60;

/** A banner while the device is offline: nothing can be saved until the connection is back. */
export function OfflineBanner() {
  const online = useSyncExternalStore(
    (cb) => { window.addEventListener("online", cb); window.addEventListener("offline", cb); return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); }; },
    () => navigator.onLine, () => true,
  );
  if (online) return null;
  return <div role="status" className="sticky top-16 z-30 bg-warn px-4 py-2 text-center text-sm font-medium text-white print:hidden">You&apos;re offline. Nothing can be saved until the connection is back.</div>;
}

/**
 * Idle lock (security.md §2): after the clinic's idle time with no activity in any tab, the
 * screen blurs with a 60-second countdown; any touch or key keeps working, otherwise the session
 * signs out on this device and the next person signs in (PIN on a trusted device).
 */
export function IdleLock({ minutes }: { minutes: number }) {
  const [left, setLeft] = useState<number | null>(null);
  const lastWrite = useRef(0);
  const signingOut = useRef(false);

  useEffect(() => {
    const now = () => Date.now();
    const mark = () => {
      const t = now();
      setLeft(null);
      if (t - lastWrite.current > 5000) { lastWrite.current = t; try { localStorage.setItem(ACTIVE_KEY, String(t)); } catch { /* private mode */ } }
    };
    const last = () => { try { return Math.max(Number(localStorage.getItem(ACTIVE_KEY) ?? 0), lastWrite.current); } catch { return lastWrite.current; } };
    mark();
    const events = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;
    for (const e of events) window.addEventListener(e, mark, { passive: true });
    const timer = setInterval(() => {
      const idle = (now() - last()) / 1000;
      const lockAt = minutes * 60;
      if (idle < lockAt) { setLeft(null); return; }
      const remaining = Math.ceil(lockAt + GRACE_S - idle);
      if (remaining > 0) { setLeft(remaining); return; }
      if (!signingOut.current) { signingOut.current = true; void signOutStaff(); }
    }, 1000);
    return () => { clearInterval(timer); for (const e of events) window.removeEventListener(e, mark); };
  }, [minutes]);

  if (left === null) return null;
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="idle-title" className="fixed inset-0 z-50 grid place-items-center bg-surface/60 backdrop-blur-xl print:hidden">
      <div className="mx-4 max-w-sm rounded-panel border border-line bg-surface p-6 text-center shadow-lg">
        <h2 id="idle-title" className="text-lg font-semibold">Still there?</h2>
        <p className="mt-1 text-ink-soft">For patients&apos; privacy you&apos;ll be signed out in {left} second{left === 1 ? "" : "s"}.</p>
        <button type="button" autoFocus className="mt-4 rounded-control bg-pine px-5 py-2.5 font-medium text-white">I&apos;m here</button>
      </div>
    </div>
  );
}
