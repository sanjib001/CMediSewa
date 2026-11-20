"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { callNext, moveVisit } from "@/app/actions/desk";
import { Button } from "@/components/ui/primitives";

/** The doctor's queue controls: call the next token, finish, or send back to the line. */
export function QueueButtons({ currentVisitId, waiting }: { currentVisitId: string | null; waiting: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string; token?: number | null }>) => start(async () => {
    setMsg(null);
    const r = await fn();
    if (!r.ok) setMsg(r.error ?? "Failed.");
    else if ("token" in r && r.token === null) setMsg("Nobody is waiting.");
    router.refresh();
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {currentVisitId ? (
        <>
          <Button type="button" disabled={pending} onClick={() => run(() => moveVisit({ visitId: currentVisitId, to: "done" }))}>Done, next patient</Button>
          <Button type="button" tone="secondary" disabled={pending} onClick={() => run(() => moveVisit({ visitId: currentVisitId, to: "waiting" }))}>Not here, back to queue</Button>
        </>
      ) : (
        <Button type="button" disabled={pending || waiting === 0} onClick={() => run(callNext)}>{waiting ? `Call next (${waiting} waiting)` : "Nobody waiting"}</Button>
      )}
      {msg ? <span role="status" className="text-sm text-ink-soft">{msg}</span> : null}
    </div>
  );
}
