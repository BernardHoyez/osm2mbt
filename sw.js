/* osm2mbt Service Worker – versioned caches, install-friendly */
const CACHE_VERSION = 'osm2mbt-v1.1.0';
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
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('static-') && k !== STATIC_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept map tiles / external tile CDNs
  const isTileHost =
    url.hostname.includes('tile.openstreetmap') ||
    url.hostname.includes('openstreetmap.fr') ||
    url.hostname.includes('lima-labs') ||
    url.hostname.includes('arcgisonline') ||
    url.hostname.includes('basemaps.cartocdn') ||
    url.hostname.includes('cdnjs.cloudflare') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('jsdelivr.net');

  if (isTileHost) return;

  // Navigation: network-first, fallback to cache
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(req, clone));
          return res;
        })
        .catch(() =>
          caches.match('./index.html').then((r) => r || caches.match(req))
        )
    );
    return;
  }

  // Same-origin static assets: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, clone));
          }
          return res;
        });
      })
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
  }
});
