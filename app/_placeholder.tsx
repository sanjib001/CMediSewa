// Phase 0 shell only: each of the five areas exists as a route group so routing and
// guards can be built against real paths. The screens themselves are Phase 1 (U1–U8).
export function Placeholder({ area, note }: { area: string; note: string }) {
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-semibold">CMediSewa · {area}</h1>
      <p className="mt-2 text-slate-600">{note}</p>
    </main>
  );
}
