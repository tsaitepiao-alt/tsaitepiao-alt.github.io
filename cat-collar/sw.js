/* WPCD local-first application shell. Updates activate only on explicit request. */
const CACHE = 'wpcd-shell-v1';
const BASE = new URL('./', self.location.href);
const SHELL = [
  './', './index.html', './styles.css', './app.js', './device.js',
  './capabilities.js', './DEVICE_INTEGRATION.md', './manifest.webmanifest',
  './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png',
  './assets/icon-maskable.png', './assets/apple-touch-icon.png',
  './assets/cat.svg', './assets/reference.jpg'
].map(path => new URL(path, BASE).href);
const STATIC = new Set(SHELL);

function safeResponse(response) {
  return response && response.ok && !response.redirected &&
    response.type !== 'opaque' &&
    new URL(response.url || BASE.href).origin === BASE.origin;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // A missing optional asset must not prevent the app shell from installing.
    await Promise.all(SHELL.map(async url => {
      try {
        const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
        if (safeResponse(response)) await cache.put(url, response);
      } catch (_) { /* Preserve the successfully cached shell assets. */ }
    }));
    const index = await cache.match(new URL('./index.html', BASE).href);
    if (!index) throw new Error('WPCD application shell was not available.');
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys())
      .filter(key => key.startsWith('wpcd-shell-') && key !== CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== BASE.origin ||
      request.headers.has('authorization')) return;
  const clean = new URL(url.href);
  clean.search = '';
  clean.hash = '';
  const root = BASE.pathname;
  const isAppNavigation = request.mode === 'navigate' &&
    (url.pathname === root || url.pathname === root + 'index.html');

  if (isAppNavigation) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (safeResponse(response)) {
          await cache.put(new URL('./index.html', BASE).href, response.clone());
        }
        return response;
      } catch (_) {
        return (await cache.match(new URL('./index.html', BASE).href)) ||
          Response.error();
      }
    })());
    return;
  }

  // Only explicitly listed, same-origin static assets enter this cache.
  // API requests, authentication routes and external resources are untouched.
  if (!STATIC.has(clean.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(clean.href);
    if (cached) return cached;
    const response = await fetch(request);
    if (safeResponse(response)) await cache.put(clean.href, response.clone());
    return response;
  })());
});
