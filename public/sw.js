// Cache only the public offline page.
const CACHE = 'byte-back-offline-v2';
const OFFLINE_PAGE = '/offline.html';

async function installOfflinePage() {
  const cache = await caches.open(CACHE);
  await cache.add(new Request(OFFLINE_PAGE, { cache: 'reload' }));
  await self.skipWaiting();
}

async function activateOfflinePage() {
  const names = await caches.keys();
  const obsolete = names.filter(name => name.startsWith('byte-back-offline-') && name !== CACHE);
  await Promise.all(obsolete.map(name => caches.delete(name)));
  await self.clients.claim();
}

self.addEventListener('install', event => event.waitUntil(installOfflinePage()));
self.addEventListener('activate', event => event.waitUntil(activateOfflinePage()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request, { cache: 'no-store' })
    .catch(() => caches.match(OFFLINE_PAGE, { cacheName: CACHE })));
});
