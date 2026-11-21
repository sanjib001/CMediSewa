export const metadata = { title: "Offline" };
export const dynamic = "force-static";

// Shown by the service worker when a page can't be reached (U8). It is the only page kept on
// the device: patient and money screens are never stored offline.
export default function Offline() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold">No connection</h1>
      <p className="text-ink-soft">CMediSewa needs the internet to show and save patients, bills and stock. Nothing is lost: what was already saved is safe on the server.</p>
      <p className="text-ink-soft">Check the Wi‑Fi or mobile data, then try again.</p>
      <a href="/employee" className="mx-auto rounded-control bg-pine px-5 py-2.5 font-medium text-white">Try again</a>
    </main>
  );
}
