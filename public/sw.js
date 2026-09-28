// Notifications only: no fetch handler, so nothing is cached.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// WebKit revokes push subscriptions that receive pushes without a notification, so it always shows one.
const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrom/.test(navigator.userAgent);

self.addEventListener('push', (event) => {
  const { title = 'Cadre', body = '', url = '/', tag } = event.data?.json() || {};
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((clients) => {
    // A visible Cadre tab already shows the in-app alert.
    if (!webkit && clients.some((client) => client.visibilityState === 'visible')) return;
    return self.registration.showNotification(title, { body, tag, data: { url }, icon: '/icons/icon.svg' });
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((clients) => {
    const client = clients[0];
    return client ? client.focus().then((focused) => focused.navigate(url)) : self.clients.openWindow(url);
  }));
});
