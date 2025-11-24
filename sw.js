/* Promptly Service Worker */
const CACHE_VERSION = 'v4';
const CORE_CACHE = `promptly-core-${CACHE_VERSION}`;
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/script.js',
  '/assets/vendor/supabase.js',
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
  const reqUrl = new URL(req.url);

  // Let the browser handle cross-origin requests directly so CSP for the page applies.
  if (reqUrl.origin !== location.origin) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok && res.type === 'basic' && !reqUrl.pathname.startsWith('/api/')) {
          const clone = res.clone();
          caches.open(CORE_CACHE).then(cache => cache.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req).then(cached => {
        if (cached) return cached;
        if (req.mode === 'navigate') {
          return caches.match('/offline.html');
        }
        return Response.error();
      }))
  );
});
