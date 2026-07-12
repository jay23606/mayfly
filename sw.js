// Cache-free development worker. app.js unregisters it on startup; this file exists
// only so browsers with an older Mayfly worker can update and release their caches.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith('mayfly-')).map((key) => caches.delete(key))
  )).then(() => self.clients.claim())
));
