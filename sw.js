const CACHE_NAME = "nexo-mates-control-v168";
const ASSETS = [
  "./",
  "./index.html",
  "./admin/index.html",
  "./catalogo",
  "./catalogo/producto.html",
  "./config.js?v=2",
  "./catalogo/config.js?v=1",
  "./catalogo/catalogo.css?v=23",
  "./catalogo/catalogo.js?v=30",
  "./catalogo/cart.js?v=2",
  "./assets/shopping-cart.svg",
  "./styles.css?v=125",
  "./product-media.js?v=1",
  "./app.js?v=308",
  "./customer-whatsapp.js?v=1",
  "./assets/whatsapp.svg",
  "./manifest.json?v=7",
  "./assets/nexo-mates-logo.png?v=1",
  "./assets/nexo-mates-icon-192.png?v=1",
  "./assets/nexo-mates-icon-512.png?v=1",
  "./assets/nexo-mates-apple-touch.png?v=1",
  "./assets/nexo-mates-favicon-32.png?v=1",
  "./assets/nexo-mates-social.png?v=1",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith("nexo-mates-") && key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const isFreshAsset = event.request.mode === "navigate" || [".html", ".js", ".css"].some((suffix) => url.pathname.endsWith(suffix));
  if (isFreshAsset) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          if (response.ok) event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
