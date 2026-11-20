"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { trustThisDevice, revokeDevice } from "@/app/actions/staff-auth";
import { Button } from "@/components/ui/primitives";
import { authInput } from "./auth-frame";

type Device = { id: string; name: string; enrolled_at: string; last_used_at: string | null; revoked_at: string | null };

export function DevicesPanel({ devices, thisDeviceId }: { devices: Device[]; thisDeviceId: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");

  return (
    <div className="space-y-6">
      {!thisDeviceId ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get("name") ?? "");
            setError(null);
            start(async () => {
              const r = await trustThisDevice({ name });
              if (r.ok) router.refresh(); else setError(r.error);
            });
          }}
        >
          <label className="block min-w-60 flex-1">
            <span className="mb-1 block text-sm font-medium">Trust this device for PIN sign-in</span>
            <input name="name" placeholder="Reception PC" required className={authInput} />
          </label>
          <Button type="submit" disabled={pending}>Trust this device</Button>
        </form>
      ) : (
        <p className="rounded-control bg-pine-tint px-4 py-2 text-pine-deep">This device is trusted. Staff can sign in here with their PIN.</p>
      )}
      {error ? <p role="alert" className="text-alert">{error}</p> : null}

      <table className="w-full text-left text-[0.95rem]">
        <thead className="text-sm text-ink-faint"><tr><th className="py-2 font-medium">Device</th><th className="py-2 font-medium">Trusted</th><th className="py-2 font-medium">Last used</th><th /></tr></thead>
        <tbody className="divide-y divide-line">
          {devices.length === 0 ? (
            <tr><td colSpan={4} className="py-4 text-ink-soft">No trusted devices yet.</td></tr>
          ) : devices.map((d) => (
            <tr key={d.id} className={d.revoked_at ? "text-ink-faint" : ""}>
              <td className="py-2.5 font-medium">{d.name}{d.id === thisDeviceId ? <span className="ml-2 text-sm font-normal text-pine">this device</span> : null}</td>
              <td className="py-2.5">{fmt(d.enrolled_at)}</td>
              <td className="py-2.5">{d.revoked_at ? `revoked ${fmt(d.revoked_at)}` : fmt(d.last_used_at)}</td>
              <td className="py-2.5 text-right">
                {!d.revoked_at ? (
                  <button type="button" disabled={pending} className="text-sm text-alert hover:underline"
                    onClick={() => start(async () => { const r = await revokeDevice({ deviceId: d.id }); if (r.ok) router.refresh(); else setError(r.error); })}>
                    Revoke
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
