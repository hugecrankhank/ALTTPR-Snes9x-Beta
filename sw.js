/*
 * Service worker: makes the site installable and lets it start offline.
 * Network-first for this site's files, so updates show up as soon as you're
 * online; the cache is only a fallback. Everything the app needs (core,
 * shaders, tracker) is served from this site, so once it has run online it
 * runs offline too.
 */
const CACHE = 'alttpr-snes9x-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './core/snes9x.wasm',
  './js/core.js', './js/video.js', './js/audio.js', './js/audio-worklet.js', './js/input.js',
  './js/storage.js', './js/bridge.js', './js/tracker.js', './js/app.js',
  './shaders/stock.glsl', './shaders/6xbrz.glsl'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('alttpr-snes9x') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.registration.scope)) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || Response.error()))
  );
});
