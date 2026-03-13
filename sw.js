// PlayLuz Service Worker - GitHub Pages compatible
const CACHE_NAME = 'playluz-v1.1.0';

// Detect base path (works on GitHub Pages subdirectories too)
const BASE = self.registration.scope;

const ASSETS = [
  BASE,
  BASE + 'index.html',
  BASE + 'manifest.json',
  BASE + 'app.js',
  BASE + 'db.js',
  BASE + 'icon-192.svg',
  BASE + 'icon-512.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        // Cache one by one to avoid failing entire batch
        return Promise.allSettled(ASSETS.map(url => cache.add(url)));
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Only handle GET requests
  if (e.request.method !== 'GET') return;
  
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request)
        .then(res => {
          // Cache new responses
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => {
          // Offline fallback: serve index.html for navigation requests
          if (e.request.mode === 'navigate') {
            return caches.match(BASE + 'index.html');
          }
        });
    })
  );
});
