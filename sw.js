/* ============================================================
   REDA AI — Service Worker
   Caches app shell for offline access
   ============================================================ */

const CACHE_NAME = 'reda-ai-v4';

const SHELL = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
];

/* INSTALL — cache only local app shell files, ignore failures */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(SHELL.map(url => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

/* ACTIVATE — delete old caches */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* FETCH — network-first for API, cache-first for app shell */
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Gemini API calls — always network, never cache
  if (url.includes('generativelanguage.googleapis.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Google Fonts — cache-first with network fallback
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(event.request).then(cached =>
        cached || fetch(event.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // External APIs (Wikipedia, etc.) — always network
  if (url.includes('wikipedia.org') || url.includes('wikimedia.org')) {
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // App shell — cache-first, fallback to network
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});