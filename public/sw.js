// Notifications only: no fetch handler, so nothing is cached.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Always shown: a subscribed device skips the in-app OS notification instead (notifications.mjs).
self.addEventListener('push', (event) => {
  const { title = 'Cadre', body = '', url = '/', tag } = event.data?.json() || {};
  event.waitUntil(self.registration.showNotification(title, { body, tag, data: { url }, icon: '/icons/icon.svg' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((clients) => {
    const client = clients[0];
    return client ? client.focus().then((focused) => focused.navigate(url)) : self.clients.openWindow(url);
  }));
});
