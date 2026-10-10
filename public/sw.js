// Notifications only: no fetch handler, so nothing is cached.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Always shown: a subscribed device skips the in-app OS notification instead (notifications.mjs).
self.addEventListener('push', (event) => {
  const { title = 'Cadre', body = '', url = '/', tag, silent = false, actions = [], queueItemId } = event.data?.json() || {};
  event.waitUntil(self.registration.showNotification(title, { body, tag, silent, actions, data: { url, queueItemId }, icon: '/icons/icon.svg' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const itemId = event.notification.data?.queueItemId;
    if (event.action && itemId) {
      try {
        const response = await fetch('/api/command-center/work-queue?status=all', { credentials: 'same-origin' });
        if (!response.ok) throw new Error('Unable to load queue');
        const item = (await response.json()).items.find((entry) => entry.id === itemId);
        if (!item || item.status !== 'open' || item.events?.some((entry) => entry.type === 'updated')
          || !item.options.some((option) => option.id === event.action)) throw new Error('Queue action expired');
        const answer = await fetch(`/api/command-center/work-queue/${encodeURIComponent(itemId)}/answer`, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ optionId: event.action }),
        });
        if (answer.ok && (await answer.json()).status !== 'delivery_failed') return;
      } catch {
        // Expired actions, lost authentication, and network failures open the item for review.
      }
    }
    const clients = await self.clients.matchAll({ type: 'window' });
    const client = clients[0];
    return client ? client.focus().then((focused) => focused.navigate(url)) : self.clients.openWindow(url);
  })());
});
