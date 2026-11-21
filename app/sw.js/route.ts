// The service worker for staff push notifications (served at /sw.js so its scope is the site).
// It shows the PHI-minimal title/body it receives and opens the link when tapped.
export const dynamic = "force-static";

const SW = `self.addEventListener("push", (event) => {
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
