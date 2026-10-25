// Cache only a PUBLIC content-free offline hint. Never cache protected data.
const CACHE='byte-back-offline-v1';
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(cache=>cache.add('/offline.html')));
  self.skipWaiting();
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys
    .filter(k=>k.startsWith('byte-back-offline-')&&k!==CACHE)
    .map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch',event=>{
  if(event.request.mode!=='navigate'||event.request.method!=='GET')return;
  event.respondWith(fetch(event.request,{cache:'no-store'})
    .catch(()=>caches.match('/offline.html')));
});
