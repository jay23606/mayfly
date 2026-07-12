// Service worker for mayfly. It stores no application data, but it does make each
// navigation and asset request bypass GitHub Pages' short HTTP cache. That keeps a
// phone from running an older interface after a deploy while retaining Web Push.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith('mayfly-')).map((key) => caches.delete(key))
  )).then(() => self.clients.claim())
));

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request, { cache: 'no-store' }));
});

// A push arrived (sent by the notify Edge Function). The payload carries only a title/body
// and a click target — never message content.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) {}
  const title = d.title || 'mayfly 🐛';
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || 'You have a new notification',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: './icon.svg',
    badge: './icon.svg',
    data: { url: d.url || './' },
  }));
});

// Focus an existing mayfly window (navigating it to the target) or open a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url || './';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if ('focus' in c) { try { if (c.navigate && target) await c.navigate(target); } catch (e) {} return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
