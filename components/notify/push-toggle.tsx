"use client";

import { useEffect, useState, useTransition } from "react";
import { removePushSubscription, savePushSubscription } from "@/app/actions/notifications";
import { Button } from "@/components/ui/primitives";

const b64 = (buf: ArrayBuffer | null) => (buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "");
const keyBytes = (k: string) => { const s = atob(k.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (k.length % 4)) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };

type State = "unsupported" | "denied" | "off" | "on" | "loading";

/** Turn push notifications on or off for this device. Shows only what the browser allows. */
export function PushToggle({ publicKey }: { publicKey: string | null }) {
  const [state, setState] = useState<State>("loading");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    (async () => {
      if (!publicKey || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) { if (live) setState("unsupported"); return; }
      if (Notification.permission === "denied") { if (live) setState("denied"); return; }
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (live) setState(sub ? "on" : "off");
    })().catch(() => live && setState("unsupported"));
    return () => { live = false; };
  }, [publicKey]);

  const turnOn = () => start(async () => {
    setError(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") { setState("denied"); return; }
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey!) });
      const r = await savePushSubscription({ endpoint: sub.endpoint, p256dh: b64(sub.getKey("p256dh")), auth: b64(sub.getKey("auth")), ua: navigator.userAgent });
      if (r.ok) setState("on"); else { await sub.unsubscribe(); setError(r.error); }
    } catch { setError("This browser couldn't turn on notifications."); }
  });
  const turnOff = () => start(async () => {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    if (sub) { await removePushSubscription(sub.endpoint); await sub.unsubscribe(); }
    setState("off");
  });

  if (state === "loading") return null;
  if (state === "unsupported") return <p className="text-sm text-ink-soft">This browser can&apos;t show notifications from CMediSewa. On a phone, add the site to the home screen first.</p>;
  if (state === "denied") return <p className="text-sm text-ink-soft">Notifications are blocked for this site in the browser settings. Allow them there, then come back.</p>;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {state === "on" ? <><span className="text-sm text-ok">On for this device.</span><Button type="button" tone="secondary" disabled={pending} onClick={turnOff}>Turn off</Button></>
        : <Button type="button" disabled={pending} onClick={turnOn}>{pending ? "Turning on…" : "Turn on for this device"}</Button>}
      {error ? <p role="alert" className="w-full text-sm text-alert">{error}</p> : null}
    </div>
  );
}
