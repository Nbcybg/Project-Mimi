// Mimi's service worker: shows push messages while the app is closed and opens the
// right chat when one is tapped. It caches nothing; the app always loads fresh.
'use strict';

const ICONS = { reminder: '⏰', approval: '✋', 'task-result': '📋' };

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Mimi', body: event.data ? event.data.text() : '' };
  }
  const icon = ICONS[data.kind];
  event.waitUntil(
    self.registration.showNotification(`${icon ? `${icon} ` : ''}${data.title || 'Mimi'}`, {
      body: data.body || '',
      icon: '/icon.png',
      badge: '/icon.png',
      tag: data.id ? `mimi-${data.id}` : undefined,
      data: { id: data.id || null, chatId: data.chatId || null },
      // An approval waits for an answer: keep it on screen until it is handled.
      requireInteraction: data.kind === 'approval',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { id, chatId } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (windows.length > 0) {
        await windows[0].focus();
        windows[0].postMessage({ type: 'open-notification', id, chatId });
        return;
      }
      await self.clients.openWindow(`/?n=${id || ''}&chat=${chatId || ''}`);
    })(),
  );
});
