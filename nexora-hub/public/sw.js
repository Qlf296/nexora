// NEXORA Hub — minimal service worker.
// Goal: make the PWA installable and let the static shell load instantly /
// offline. API calls (chat streaming, widgets, health) are NEVER intercepted
// — they always hit the network directly so SSE streaming and live data stay
// correct.

const CACHE_VERSION = "nexora-hub-v1";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isNetworkOnly(pathname) {
  return pathname.startsWith("/api/") || pathname === "/healthz";
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never intercept API / streaming / health traffic.
  if (event.request.method !== "GET" || isNetworkOnly(url.pathname) || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);

      // Shell assets: serve cached instantly, refresh in background.
      return cached || networkFetch;
    })
  );
});
