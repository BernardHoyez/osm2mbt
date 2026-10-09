/* osm2mbt Service Worker – cache-busting versioned caches */
const CACHE_VERSION = 'osm2mbt-v1.0.1';
const STATIC_CACHE = `static-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './css/style.css',
  './css/leaflet-areaselect.css',
  './js/app.js',
  './js/leaflet-areaselect.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('static-') && k !== STATIC_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache tile requests or external CDNs for tiles
  if (
    url.hostname.includes('tile.openstreetmap') ||
    url.hostname.includes('openstreetmap.fr') ||
    url.pathname.includes('/tiles/')
  ) {
    return;
  }

  // Network-first for navigation / HTML to break stale caches
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && event.request.method === 'GET') {
          const clone = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(event.request, clone));
        }
        return res;
      });
    })
  );
});

// Message to force update
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
