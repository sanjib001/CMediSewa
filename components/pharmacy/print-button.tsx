"use client";

export function PrintButton() {
  return <button type="button" onClick={() => window.print()} className="rounded-control bg-pine px-4 py-2 font-medium text-white print:hidden">Print</button>;
}
