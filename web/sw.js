/* Offline-first. The app is fully usable with no network at all -- readings
   live in IndexedDB, so the only thing the cache has to hold is the shell. */
'use strict';
const VERSION = '__BUILD_VERSION__';
const BASE = new URL('./', self.location.href);
const SCOPE_KEY = BASE.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
// Preserve the legacy root cache prefix so an update deletes the old shell.
// A project-path install gets a scoped prefix and cannot remove another PWA's
// cache on the same github.io origin.
const CACHE_PREFIX = BASE.pathname === '/' ? 'bp-shell-' : `bp-shell-${SCOPE_KEY}-`;
const CACHE = CACHE_PREFIX + VERSION;
const SHELL = ['./', './index.html', './app.css', './app.js', './db.js', './bp.js', './i18n.js',
               './backup.js', './aggregate.js', './icons.js', './insights.js', './palette.js',
               './ocr-audit.js', './pdf.js', './pwa-update.js', './sw-update.js',
               './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png',
               './icons/icon-512.png', './icons/maskable-512.png',
               // Local OCR: implementation, pinned runtime and matching models.
               './hearth/reader.js', './hearth/inference-worker.js',
               './hearth/reading.js', './hearth/crop-fallback.js',
               './hearth/adaptive-crop.js', './hearth/display-rectification.js',
               './hearth/vendor/ort.wasm.min.mjs',
               './hearth/vendor/ort-wasm-simd-threaded.mjs',
               './hearth/vendor/ort-wasm-simd-threaded.wasm',
               './hearth/models/bp-detector.onnx',
               './hearth/models/bp-digits.onnx',
               './hearth/models/config.json'];

const assetUrl = (path) => new URL(path, BASE);
const canonicalUrl = (request) => {
  const url = new URL(request.url);
  url.search = '';
  return url;
};

importScripts(assetUrl('./sw-update.js').href);

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL.map((url) => new Request(assetUrl(url), { cache: 'reload' })));
    // Locales are fetched on demand; pre-cache only the ones likely needed.
    await c.addAll([assetUrl('./i18n/en.json').href]).catch(() => {});
    // Take over immediately; combined with controllerchange in the page this
    // turns a deploy into a single automatic reload.
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE)
                          .map((k) => caches.delete(k)));
    await self.clients.claim();
    // Tell the open windows rather than reloading them from under whatever
    // the person was doing. Each page decides when it is safe.
    await announceUpdate();
  })());
});

/* Two strategies, chosen by whether the URL can go stale.

   Assets requested with ?v=<hash> are immutable -- a new build is a new URL --
   so those are cache-first. Everything else, the HTML above all, is
   network-first: cache-first HTML means a refresh serves yesterday's page,
   which then asks for yesterday's script, and the app only updates on the
   *second* reload. That is the trap this used to fall into. */
const immutable = (url) => url.searchParams.has('v');

async function networkFirst(req, cache) {
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req) || await cache.match(canonicalUrl(req).href);
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match(assetUrl('./index.html').href);
      if (shell) return shell;
    }
    throw err;
  }
}

async function cacheFirst(req, cache) {
  // The install cache stores canonical paths, while deployed HTML and module
  // imports carry ?v=<build>. Falling back to the canonical entry makes the
  // very first installed load work offline, before a controlled page has had
  // a chance to request and cache every versioned URL.
  const hit = await cache.match(req) || await cache.match(canonicalUrl(req).href);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return (immutable(url) ? cacheFirst : networkFirst)(req, cache);
  })());
});
