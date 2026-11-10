// Service worker : l'application et les tuiles déjà vues restent disponibles hors ligne (champs sans réseau).
const APP = 'fency-app-v1';
const TILES = 'fency-tiles-v1';
const MAX_TILES = 2500;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function trim(cacheName, max) {
  const c = await caches.open(cacheName), keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin) {
    // réseau d'abord (mises à jour), cache en secours (hors ligne)
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(APP)).put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req)) || (req.mode === 'navigate' ? await caches.match('./index.html') || await caches.match('./') : Response.error());
      }
    })());
  } else if (req.destination === 'image') {
    // tuiles de carte : cache d'abord
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(TILES); await c.put(req, res.clone()); trim(TILES, MAX_TILES); }
      return res;
    })());
  }
});
