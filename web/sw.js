// Keeps the app shell available offline. App files are network-first so updates arrive straight away;
// AniList data is never cached here (the app keeps its own copy).
// Posters and banners from AniList's image server are cache-first: they never change at a given URL,
// and iOS often empties a Home Screen app's normal browser cache, which made every launch re-download them.
const CACHE = 'anitrack-v3';
const IMAGES = 'anitrack-img-v3';
const MAX_IMAGES = 600; // roughly 30 MB of posters; the oldest are dropped first
const SHELL = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== IMAGES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const isArtwork = (url) => url.protocol === 'https:' && /(^|\.)anilist\.co$/.test(url.hostname) && url.hostname !== 'graphql.anilist.co';

let trimming = null;
function trimImages() {
  // Runs at most once at a time; cache.keys() lists entries oldest first.
  if (trimming) return;
  trimming = caches
    .open(IMAGES)
    .then(async (c) => {
      const keys = await c.keys();
      await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_IMAGES)).map((k) => c.delete(k)));
    })
    .catch(() => {})
    .finally(() => (trimming = null));
}

async function artwork(request) {
  const cache = await caches.open(IMAGES);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  try {
    // A CORS response can be stored at its real size; an opaque one is padded to megabytes by some
    // browsers, so it is shown but not kept.
    const res = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
    if (res.ok) {
      cache.put(request.url, res.clone()).then(trimImages, () => {});
      return res;
    }
  } catch {
    /* no CORS on this host, or offline: plain request below */
  }
  return fetch(request);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (isArtwork(url)) {
    e.respondWith(artwork(e.request));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
