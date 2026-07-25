/* Service worker RandoCarte — met l'application elle-même en cache pour un démarrage 100 % hors ligne.
   Les tuiles de carte, elles, sont gérées dans IndexedDB par app.js. */
const VERSION = "randocarte-v5";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./vendor/leaflet.js",
  "./vendor/leaflet.css",
  "./vendor/images/layers.png",
  "./vendor/images/layers-2x.png",
  "./vendor/images/marker-icon.png",
  "./vendor/images/marker-icon-2x.png",
  "./vendor/images/marker-shadow.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Ne jamais intercepter les serveurs de tuiles : app.js gère leur cache dans IndexedDB.
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(e.request).then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return r;
        })
    )
  );
});
