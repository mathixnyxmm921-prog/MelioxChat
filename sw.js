// Service worker de Meliox: recibe las notificaciones push aunque la app esté cerrada.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Si ya estás mirando Meliox, no hace falta avisarte
      if (wins.some((w) => w.visibilityState === "visible" && w.focused)) return;

      const isCall = data.type === "call";
      await self.registration.showNotification(data.title || "Meliox", {
        body: data.body || "Tienes un mensaje nuevo",
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: data.tag || "meliox",
        renotify: true,
        // Las llamadas se quedan en pantalla y vibran como un timbre
        requireInteraction: isCall,
        vibrate: isCall ? [400, 200, 400, 200, 400, 200, 400] : [150, 80, 150],
        data: { phone: data.phone || null },
      });
    })()
  );
});

// Al tocar la notificación: abre Meliox directo en el chat de quien escribió
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const phone = event.notification.data && event.notification.data.phone;

  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await w.focus();
          if (phone) w.postMessage({ type: "open-chat", phone });
          return;
        }
      }
      await self.clients.openWindow(phone ? "/?chat=" + phone : "/");
    })()
  );
});
