/**
 * Offline shell for the app.
 *
 * The important rule: the HTML document must be fetched network-first.
 * index.html names the hashed build assets, so serving a cached copy of it
 * after a new deploy points the browser at asset filenames that no longer
 * exist - which renders as a blank page with no console error. Hashed assets
 * under /assets/ are safe to serve cache-first, because their names change
 * whenever their contents do.
 */
const VERSION = "v3";
const SHELL_CACHE = `sembarang-budal-shell-${VERSION}`;
const ASSET_CACHE = `sembarang-budal-assets-${VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE];

const SHELL_URLS = ["/", "/manifest.json", "/icon-192.svg", "/icon-512.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // A failed precache must not abort the install, or the worker never
      // activates and the app has no offline fallback at all.
      .then((cache) => Promise.allSettled(SHELL_URLS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => !CURRENT_CACHES.includes(key)).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

function isHashedAsset(url) {
  return url.pathname.startsWith("/assets/");
}

/** Cache-first: the filename encodes the content, so a hit is always correct. */
async function assetFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    return cached;
  }

  const response = await fetch(request);

  if (response.ok) {
    cache.put(request, response.clone());
  }

  return response;
}

/** Network-first with a cached fallback, for HTML and other static files. */
async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);

    if (response.ok) {
      cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    const cached = await cache.match(request);

    if (cached) {
      return cached;
    }

    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);

      if (fallback) {
        return fallback;
      }
    }

    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // API responses are never cached - a stale place list is worse than none.
  if (url.pathname.startsWith("/api")) {
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(assetFirst(request));
    return;
  }

  // Navigations fall back to the cached shell so the app still opens offline.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE, "/"));
    return;
  }

  event.respondWith(networkFirst(request, SHELL_CACHE));
});
