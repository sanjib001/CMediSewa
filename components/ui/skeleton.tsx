import { cn } from "@/lib/cn";

// Skeleton loaders (owner): grey blocks in the shape of the screen while it loads, so a slow
// connection shows "something is coming" instead of a frozen page. Purely visual: the whole
// placeholder is announced once as "Loading" to screen readers.

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("skeleton block rounded-control", className)} />;
}

/** A staff screen: page title, a row of tabs or filters, and a panel of rows. */
export function PageSkeleton({ variant = "list" }: { variant?: "list" | "dashboard" | "counter" }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-6">
      <span className="sr-only">Loading</span>
      <div className="space-y-2.5">
        <Skeleton className="h-8 w-56 max-w-[70%]" />
        <Skeleton className="h-4 w-80 max-w-[85%]" />
      </div>
      {variant === "dashboard" ? (
        <>
          <div className="flex gap-6"><Skeleton className="h-12 w-20" /><Skeleton className="h-12 w-20" /><Skeleton className="h-12 w-20" /><Skeleton className="hidden h-12 w-20 sm:block" /></div>
          <div className="grid gap-6 xl:grid-cols-[1.35fr_1fr]"><Rows n={5} /><Rows n={4} /></div>
        </>
      ) : variant === "counter" ? (
        <>
          <div className="flex gap-4 border-b border-line pb-3"><Skeleton className="h-6 w-20" /><Skeleton className="h-6 w-14" /><Skeleton className="h-6 w-16" /><Skeleton className="h-6 w-14" /></div>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_23rem]">
            <div className="space-y-3"><Skeleton className="h-11 w-full" /><Skeleton className="h-4 w-2/3" /></div>
            <div className="space-y-3 rounded-panel border border-line p-4"><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="ml-auto h-10 w-40" /><Skeleton className="h-12 w-full" /></div>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-2"><Skeleton className="h-9 w-24" /><Skeleton className="h-9 w-28" /><Skeleton className="h-9 w-20" /></div>
          <Rows n={7} />
        </>
      )}
    </div>
  );
}

function Rows({ n }: { n: number }) {
  return (
    <div className="rounded-panel border border-line bg-surface">
      <div className="border-b border-line px-5 py-3.5"><Skeleton className="h-5 w-36" /></div>
      <ul className="divide-y divide-line">
        {Array.from({ length: n }, (_, i) => (
          <li key={i} className="flex items-center gap-4 px-5 py-3.5">
            <Skeleton className="size-3 shrink-0 rounded-full" />
            <Skeleton className={cn("h-4", ["w-3/5", "w-2/5", "w-1/2", "w-3/4"][i % 4])} />
            <Skeleton className="ml-auto h-4 w-16 shrink-0" />
          </li>
        ))}
      </ul>
    </div>
  );
}
