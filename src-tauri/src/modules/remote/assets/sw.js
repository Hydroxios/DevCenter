// Service worker DevCenter : notifications push et pastille sur l'icône.
// Aucune mise en cache des données : le tableau de bord est toujours en direct.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "DevCenter", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "DevCenter";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { tab: data.tab || "home" },
  };
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      // Pastille : nombre de notifications non lues.
      if (self.navigator && "setAppBadge" in self.navigator) {
        const shown = await self.registration.getNotifications();
        try {
          await self.navigator.setAppBadge(shown.length);
        } catch (e) {}
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = "/#" + ((event.notification.data && event.notification.data.tab) || "home");
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
