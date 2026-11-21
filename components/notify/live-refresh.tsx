"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-renders the current page when something on one of its topics changes (D-09, D-114).
 * The stream carries topic names only; the refresh runs the page's own permission checks.
 * Several changes close together cause one refresh. Renders nothing.
 */
export function LiveRefresh({ topics }: { topics: string[] }) {
  const router = useRouter();
  const key = topics.join(",");
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource(`/api/realtime?topics=${encodeURIComponent(key)}`);
    es.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 400);
    };
    return () => { clearTimeout(timer); es.close(); };
  }, [key, router]);
  return null;
}
