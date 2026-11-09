"use strict";

self.addEventListener("push", (event) => {
  let data = { title: "Meliox", body: "Nuevo mensaje", phone: "" };
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    data.body = event.data.text();
  }

  const options = {
    body: data.body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "meliox-notif",
    data: { phone: data.phone }
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "Meliox", options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const phone = event.notification.data && event.notification.data.phone;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.focus();
          if (phone) {
            client.postMessage({ type: "open-chat", phone: phone });
          }
          return;
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(phone ? `/?chat=${phone}` : "/");
      }
    })
  );
});
