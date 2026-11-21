// The service worker for staff push notifications (served at /sw.js so its scope is the site).
// It shows the PHI-minimal title/body it receives and opens the link when tapped.
export const dynamic = "force-static";

// Offline (U8): the ONLY thing cached is the /offline page. Page loads go to the network; if
// that fails, the offline page is shown. No patient, bill or stock page is ever stored.
const SW = `const OFFLINE_CACHE = "cm-offline-v1";
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((c) => c.add(new Request("/offline", { cache: "reload" }))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== OFFLINE_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match("/offline").then((r) => r || Response.error())));
});
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { title: "CMediSewa" }; }
  event.waitUntil(self.registration.showNotification(d.title || "CMediSewa", {
    body: d.body || "", data: { link: typeof d.link === "string" && d.link.startsWith("/") ? d.link : "/employee/notifications" }, tag: d.link || undefined,
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data.link, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) { if (c.url === url && "focus" in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
`;

export function GET() {
  return new Response(SW, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/" } });
}
