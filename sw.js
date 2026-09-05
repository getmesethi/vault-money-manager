// Vault service worker — enables "Add to Home Screen" installability and
// basic offline access to the app shell. Never caches Supabase API calls;
// your financial data always comes from the network, live.
const CACHE_NAME = 'vault-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/crypto.js',
  './js/webauthn.js',
  './js/model.js',
  './js/supa.js',
  './js/store.js',
  './js/charts.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin GET requests for the app shell. Everything else
  // (Supabase REST/Realtime/Auth, the supabase-js CDN script, POSTs) passes
  // straight through to the network untouched.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return resp;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});
