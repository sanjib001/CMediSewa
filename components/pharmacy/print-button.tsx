"use client";

export function PrintButton({ label }: { label?: string } = {}) {
  return <button type="button" onClick={() => window.print()} className="rounded-control bg-pine px-4 py-2 font-medium text-white print:hidden">{label ?? "Print"}</button>;
}
