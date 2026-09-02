/* AYEN Rider Service Worker — push + offline shell */
const CACHE = 'ayen-rider-v3';
const PRECACHE = ['/rider.html', '/rider', '/manifest-rider.json', '/rider-icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Network-first for API; cache fallback for shell
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('/rider.html')))
  );
});

self.addEventListener('push', (event) => {
  let data = { title: 'Ayen Rider', body: 'Order baharu', url: '/rider.html', tag: 'ayen-rider' };
  try {
    if (event.data) {
      const j = event.data.json();
      data = Object.assign(data, j);
    }
  } catch (_) {
    try { data.body = event.data.text(); } catch (e) {}
  }
  const title = data.title || 'Ayen Rider';
  const options = {
    body: data.body || 'Kemaskini order',
    icon: '/rider-icon.svg',
    badge: '/rider-icon.svg',
    tag: data.tag || 'ayen-rider',
    renotify: true,
    requireInteraction: true,
    data: { url: data.url || '/rider.html', orderId: data.orderId || null },
    actions: [
      { action: 'open', title: 'Buka app' },
      { action: 'dismiss', title: 'Tutup' }
    ]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const target = (event.notification.data && event.notification.data.url) || '/rider.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes('rider') && 'focus' in c) {
          c.postMessage({ type: 'PUSH_OPEN', orderId: event.notification.data && event.notification.data.orderId });
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
