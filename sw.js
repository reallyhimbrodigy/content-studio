/* Promptly Service Worker */
const CACHE_VERSION = 'v1';
const CORE_CACHE = `promptly-core-${CACHE_VERSION}`;
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/styles.min.css',
  '/styles.css',
  '/script.js',
  '/assets/promptly-icon.svg',
  '/offline.html'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CORE_CACHE).then(cache => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('promptly-core-') && k !== CORE_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        // Cache successful basic responses
        if (res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CORE_CACHE).then(cache => cache.put(req, clone));
        }
        return res;
      }).catch(() => caches.match('/offline.html'));
    })
  );
});
