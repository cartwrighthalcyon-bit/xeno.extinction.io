// XENO.IO service worker: lets the game open offline and install as an app.
const CACHE = 'xenoio-v2-2';
const CORE = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname.startsWith('/.well-known/')) return;
  // network first so updates arrive immediately; fall back to the cached copy when offline
  e.respondWith(fetch(e.request).then(r => { if (r.ok && (u.pathname === '/' || CORE.includes(u.pathname))) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(u.pathname === '/' ? '/' : e.request, cp)); } return r; })
    .catch(() => caches.match(u.pathname === '/' || u.pathname === '/index.html' ? '/' : e.request)));
});
