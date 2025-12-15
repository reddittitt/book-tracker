const CACHE_NAME = "reading-tracker-v2_1"; // bump this when you deploy changes
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./data.json",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (k === CACHE_NAME ? null : caches.delete(k))))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Network-first for app shell too (so updates propagate better)
  if (req.url.endsWith("/app.js") || req.url.includes("app.js") ||
      req.url.endsWith("/index.html") || req.url.includes("index.html")) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Network-first for data.json so GitHub commits update it
  if (req.url.includes("data.json")) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for the rest
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req))
  );
});
