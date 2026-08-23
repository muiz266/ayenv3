/* AYEN KETAM NIPAH Rider PWA — optimasi offline & prestasi */
const CACHE_STATIC = 'ayen-rider-static-v3';
const CACHE_PAGES = 'ayen-rider-pages-v3';
const CACHE_RUNTIME = 'ayen-rider-runtime-v3';

const PRECACHE = [
  '/rider',
  '/rider.html',
  '/manifest-rider.json',
  '/rider-icon.svg',
  '/sw-rider.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_STATIC);
      // addAll gagal jika 1 fail — cache satu demi satu
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'reload' });
            if (res.ok) await cache.put(url, res.clone());
          } catch (_) {}
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([CACHE_STATIC, CACHE_PAGES, CACHE_RUNTIME]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

function isApi(url) {
  return url.pathname.startsWith('/api/');
}

function isNav(request) {
  return request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept') || '').includes('text/html');
}

function isStaticAsset(url) {
  return /\.(js|css|svg|png|jpg|jpeg|webp|woff2?|json)$/i.test(url.pathname) ||
    url.pathname.includes('manifest');
}

/** Network-first, fallback cache (untuk HTML / halaman) */
async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (_) {
    const cached = await cache.match(request) ||
      await caches.match(request) ||
      (fallbackUrl ? await caches.match(fallbackUrl) : null);
    if (cached) return cached;
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title></head><body style="font-family:system-ui;padding:24px;text-align:center"><h2>Anda offline</h2><p>Sambungan terputus. Buka semula bila ada internet.</p><button onclick="location.reload()">Cuba lagi</button></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

/** Cache-first, revalidate di latar (aset statik — pantas) */
async function cacheFirstRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (cached) {
    networkPromise.catch(() => {});
    return cached;
  }
  const fresh = await networkPromise;
  if (fresh) return fresh;
  return new Response('', { status: 504, statusText: 'Offline' });
}

/** Stale-while-revalidate untuk runtime GET bukan API */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (cached) {
    networkPromise.catch(() => {});
    return cached;
  }
  const fresh = await networkPromise;
  return fresh || new Response(JSON.stringify({ offline: true }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API: network only (data sentiasa hidup)
  if (isApi(url)) return;

  if (isNav(request) || url.pathname === '/rider' || url.pathname.endsWith('rider.html')) {
    event.respondWith(networkFirst(request, CACHE_PAGES, '/rider.html'));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirstRevalidate(request, CACHE_STATIC));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, CACHE_RUNTIME));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('push', (event) => {
  let data = { title: 'AYEN KETAM NIPAH Rider', body: 'Kemaskini baharu' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/rider-icon.svg',
      badge: '/rider-icon.svg',
      data: data.url || '/rider'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data || '/rider';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes('rider') && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
