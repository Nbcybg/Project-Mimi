// Mimi's service worker: shows push messages while the app is closed and opens the
// right chat when one is tapped. The app always loads fresh from the server; the only thing
// kept here is a short "no connection" page, which holds nothing of anyone's chats.
'use strict';

const ICONS = { reminder: '⏰', approval: '✋', 'task-result': '📋' };
const OFFLINE_CACHE = 'mimi-offline-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.add(new Request('/offline.html', { cache: 'reload' }))));
});
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== OFFLINE_CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);

// Opening the app (from the home screen) without a connection shows that page instead of the
// browser's error. Everything else goes straight to the network.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.match('/offline.html')) || Response.error()));
});

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
