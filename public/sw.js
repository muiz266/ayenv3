/* AYEN KETAM NIPAH — notifikasi gaya native mobile */
const CACHE = 'akn-customer-v2';
const PRECACHE = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});

function showNativeStyleNotification(data) {
  const title = data.title || 'AYEN KETAM NIPAH';
  const options = {
    body: data.body || 'Kemaskini pesanan anda',
    icon: '/rider-icon.svg',
    badge: '/rider-icon.svg',
    tag: data.tag || 'akn-order',
    renotify: true,
    requireInteraction: true,
    vibrate: data.vibrate || [200, 100, 200],
    timestamp: Date.now(),
    data: {
      url: data.url || '/?open=history',
      orderId: data.orderId || null
    },
    actions: [
      { action: 'open', title: 'Buka' },
      { action: 'dismiss', title: 'Tutup' }
    ]
  };
  return self.registration.showNotification(title, options);
}

self.addEventListener('push', (event) => {
  let data = {
    title: 'AYEN KETAM NIPAH',
    body: 'Kemaskini pesanan anda',
    url: '/?open=history',
    tag: 'akn-order'
  };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (_) {
    try {
      if (event.data) data.body = event.data.text();
    } catch (_) {}
  }
  event.waitUntil(showNativeStyleNotification(data));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = (event.notification.data && event.notification.data.url) || '/?open=history';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.postMessage({ type: 'NOTIFICATION_OPEN', data: event.notification.data });
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SHOW_PERSIST') {
    event.waitUntil(showNativeStyleNotification(event.data.payload || {}));
  }
  if (event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
