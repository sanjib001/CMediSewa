"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { markRead } from "@/app/actions/notifications";

export function MarkAllRead() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return <button type="button" disabled={pending} onClick={() => start(async () => { await markRead(null); router.refresh(); })} className="text-sm text-pine hover:underline disabled:opacity-50">Mark all as read</button>;
}
