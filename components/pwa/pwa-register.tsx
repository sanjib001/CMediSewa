"use client";

import { useEffect } from "react";

/** Registers the service worker (push + the offline page) for every visitor. Renders nothing. */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => { /* not fatal: the app works without it */ });
  }, []);
  return null;
}
