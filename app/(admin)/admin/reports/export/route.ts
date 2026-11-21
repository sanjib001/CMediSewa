import { requireTenant } from "@/lib/auth/context";
import { audit } from "@/lib/audit";
import { REPORTS, allowedReports, columnsFor, reportStores, runReport, seesCost, toCsv, type ReportKey } from "@/lib/reports/data";
import { todayIn } from "@/lib/desk/data";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// CSV download of a report (W-17 §7): needs an A3 (two-factor) session, follows the same
// permissions and store access as the page, and is written to the audit log.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const ctx = await requireTenant({ operation: "export", allowPendingTenant: true, next: `/admin/reports?${url.searchParams}` });
  const key = url.searchParams.get("r") as ReportKey;
  if (!allowedReports(ctx).includes(key)) return new Response("Not found", { status: 404 });
  const def = REPORTS[key];
  const today = todayIn();
  const to = DATE.test(url.searchParams.get("to") ?? "") && url.searchParams.get("to")! <= today ? url.searchParams.get("to")! : today;
  const fromRaw = url.searchParams.get("from") ?? "";
  const from = DATE.test(fromRaw) && fromRaw <= to ? fromRaw : `${to.slice(0, 8)}01`;
  if (Date.parse(to) - Date.parse(from) > 400 * 86_400_000) return new Response("Period too long", { status: 400 });
  const days = Math.min(730, Math.max(0, Number(url.searchParams.get("days") ?? 90) || 90));
  let store: string | null = null;
  if (def.store) {
    const { stores, all } = await reportStores(ctx);
    const want = url.searchParams.get("store");
    store = stores.find((s) => s.id === want)?.id ?? null;
    if (!store && !all) return new Response("Choose a store", { status: 400 });
  }
  const rows = await runReport(ctx.tenantId, key, { from, to, days, store });
  const csv = toCsv(columnsFor(key, seesCost(ctx)), rows);
  await audit({ tenantId: ctx.tenantId, actorKind: "member", actorId: ctx.memberId, sessionLevel: ctx.level, action: "report.export", targetType: "report", targetId: key,
    detail: { from: def.filter === "period" ? from : null, to, days: def.filter === "days" ? days : null, store, rows: rows.length } });
  const name = `${key}-${def.filter === "period" ? `${from}_${to}` : def.filter === "day" ? to : `${days}d`}.csv`;
  return new Response("﻿" + csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" },
  });
}
