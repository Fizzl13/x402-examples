// Service worker for the Fizzl wallet dashboard installed as an app: it shows
// notifications (approvals, alerts) and opens the dashboard when one is tapped.
// On Android an approval also has Approve / Deny buttons; on iPhone a tap opens
// the dashboard on the approval. Nothing is cached: the dashboard always loads
// fresh from the server.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch { m = { body: event.data?.text() ?? "" }; }
  const options = {
    body: m.body ?? "",
    tag: m.tag ?? "fizzl",
    renotify: true,
    icon: "/app/icon-192.png",
    badge: "/app/badge-96.png",
    data: { url: m.url ?? "/#/overview", approval: m.approval ?? null },
    requireInteraction: !!m.requireInteraction,
    ...(m.approval ? { actions: [{ action: "approve", title: "Approve" }, { action: "deny", title: "Deny" }] } : {}),
  };
  event.waitUntil(self.registration.showNotification(m.title ?? "Fizzl wallet", options));
});

async function openDashboard(url) {
  const target = new URL(url, self.location.origin).href;
  const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of open) {
    if (new URL(c.url).origin === self.location.origin) {
      await c.focus();
      return c.navigate ? c.navigate(target).catch(() => c) : c;
    }
  }
  return self.clients.openWindow(target);
}

self.addEventListener("notificationclick", (event) => {
  const n = event.notification, { url, approval } = n.data ?? {};
  n.close();
  if (approval && (event.action === "approve" || event.action === "deny")) {
    event.waitUntil((async () => {
      const res = await fetch(`/api/approvals/${encodeURIComponent(approval)}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: event.action }) }).catch(() => null);
      const done = res?.ok ? await res.json().catch(() => null) : null;
      // Signed out, already answered or expired: show the dashboard, where the answer is visible.
      if (!done || !["approved", "denied"].includes(done.status)) return openDashboard(url);
      return self.registration.showNotification(done.status === "approved" ? "Approved" : "Denied", { body: n.body, tag: n.tag, icon: "/app/icon-192.png", badge: "/app/badge-96.png", data: { url } });
    })());
    return;
  }
  event.waitUntil(openDashboard(url ?? "/#/overview"));
});
