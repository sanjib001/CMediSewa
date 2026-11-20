"use client";

import { goLive } from "@/app/actions/setup";
import { ActionForm } from "@/components/platform/action-form";

/** W-02: the clinic admin takes the clinic live once nothing blocks it. */
export function GoLiveButton({ ready }: { ready: boolean }) {
  return (
    <ActionForm action={goLive} submitLabel={ready ? "Go live" : "Check again and go live"}
      confirm="Go live? Your public page and online booking (when enabled) start working.">
      <></>
    </ActionForm>
  );
}
