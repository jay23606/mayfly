// mayfly service worker — network-first so the live app + Supabase Realtime signaling
// are never served stale; falls back to cache only when offline.
const CACHE = 'mayfly-v23';
const ASSETS = ['./', './index.html', './styles.css', './manifest.json', './icon.svg',
    './app.js', './core.js', './util.js', './filters.js', './db.js', './rtc.js', './crypto.js', './chat.js', './groups.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;                 // never cache API writes
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;           // let Supabase / STUN pass through
  e.respondWith(
    fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy));
      return res;
    }).catch(() => caches.match(request))
  );
});
