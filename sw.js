// Offline cache. Bump VERSION on every deploy so installed apps pick up new files.
const VERSION = 'ledger-v7';
const SHELL = [
  './', './index.html', './config.js', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/brain.js', './js/agent.js', './js/db.js', './js/sync.js', './js/loader.js', './vendor/supabase.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];
const CDN_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'ledger-cdn').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req, req.mode === 'navigate' ? './index.html' : null));
    return;
  }
  if (CDN_HOSTS.includes(url.hostname)) e.respondWith(cacheFirst(req));
});
// App files: try the network (fresh code), fall back to cache when offline.
async function networkFirst(req, fallback) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(fallback || req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(fallback || req, { ignoreSearch: true });
    return hit || new Response('Offline', { status: 503 });
  }
}
async function cacheFirst(req) {
  const cache = await caches.open('ledger-cdn');
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch {
    return new Response('', { status: 503 });
  }
}
