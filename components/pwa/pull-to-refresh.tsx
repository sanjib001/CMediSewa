"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const TRIGGER = 72;   // px of (damped) pull that refreshes
const MAX = 110;

/**
 * Pull down to refresh (owner, phones and tablets). From the very top of a staff screen, drag
 * down: a spinner follows the finger; let go past the line and the screen reloads its data
 * (router.refresh: fresh server data, nothing typed in a form is lost). The installed app has no
 * browser pull-to-refresh, and in a browser tab this replaces the built-in one so it doesn't
 * reload the whole page twice. Touch screens only; off while a menu or dialog is open.
 */
export function PullToRefresh() {
  const router = useRouter();
  const [pull, setPull] = useState(0);
  const [refreshing, startRefresh] = useTransition();
  const [held, setHeld] = useState(false);   // keep the spinner up at least a moment
  const start = useRef<number | null>(null);
  const pullRef = useRef(0);

  useEffect(() => {
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    const root = document.documentElement;
    const before = root.style.overscrollBehaviorY;
    root.style.overscrollBehaviorY = "contain";
    const blocked = (t: EventTarget | null) => {
      if (document.querySelector("dialog[open], details[open] > div")) return true;
      for (let el = t as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
        if (el.scrollTop > 0) return true;                       // a scrolled list inside the page
      }
      return false;
    };
    const set = (v: number) => { pullRef.current = v; setPull(v); };
    const onStart = (e: TouchEvent) => {
      start.current = window.scrollY <= 0 && e.touches.length === 1 && !blocked(e.target) ? e.touches[0]!.clientY : null;
    };
    const onMove = (e: TouchEvent) => {
      if (start.current === null) return;
      const dy = e.touches[0]!.clientY - start.current;
      if (dy <= 0 || window.scrollY > 0) { if (pullRef.current) set(0); return; }
      if (e.cancelable) e.preventDefault();                      // our pull, not the page's
      set(Math.min(MAX, dy * 0.5));
    };
    const onEnd = () => {
      if (start.current === null) return;
      start.current = null;
      if (pullRef.current >= TRIGGER) {
        setHeld(true);
        startRefresh(() => router.refresh());
        setTimeout(() => setHeld(false), 600);
      }
      set(0);
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      root.style.overscrollBehaviorY = before;
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [router]);

  const busy = refreshing || held;
  if (!pull && !busy) return null;
  const ready = pull >= TRIGGER;
  const y = busy ? 56 : pull;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-40 flex justify-center" style={{ transform: `translateY(${Math.max(0, y - 40)}px)` }}>
      <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[0.95rem] font-medium text-ink shadow-md">
        <svg viewBox="0 0 24 24" className={busy ? "ptr-spin size-5 text-pine" : "size-5 text-pine"} aria-hidden
          style={busy ? undefined : { transform: `rotate(${Math.round((pull / TRIGGER) * 270)}deg)` }}>
          <path d="M12 3a9 9 0 1 1-8.5 6" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
          {busy ? null : <path d="M3.5 3.5v5.5H9" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
        {busy ? "Refreshing…" : ready ? "Release to refresh" : "Pull to refresh"}
      </div>
    </div>
  );
}
