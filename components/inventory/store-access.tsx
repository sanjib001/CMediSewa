"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setStoreAccess } from "@/app/actions/inventory";

/** Who works in this store: view, operate (sell/receive) or manage (post stock documents). */
export function StoreAccess({ storeId, members, access }: {
  storeId: string; members: { id: string; display_name: string; membership_role: string }[]; access: { member_id: string; access: string }[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div>
      <ul className="divide-y divide-line">
        {members.map((m) => {
          const admin = m.membership_role === "tenant_admin";
          const cur = admin ? "manage" : access.find((a) => a.member_id === m.id)?.access ?? "none";
          return (
            <li key={m.id} className="flex items-center justify-between gap-3 py-2">
              <span>{m.display_name}{admin ? <span className="text-sm text-ink-faint"> (clinic admin: every store)</span> : null}</span>
              {admin ? null : (
                <select value={cur} disabled={pending} aria-label={`${m.display_name}'s access`} className="rounded-control border border-line-strong px-2 py-1 text-sm"
                  onChange={(e) => start(async () => {
                    setError(null);
                    const r = await setStoreAccess({ storeId, memberId: m.id, access: e.target.value as "none" });
                    if (!r.ok) setError(r.error); else router.refresh();
                  })}>
                  <option value="none">No access</option><option value="view">View</option><option value="operate">Operate</option><option value="manage">Manage</option>
                </select>
              )}
            </li>
          );
        })}
      </ul>
      {error ? <p role="alert" className="mt-2 text-sm text-alert">{error}</p> : null}
    </div>
  );
}
