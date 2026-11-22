// Caches the app shell so it opens with no signal. Data is handled in app.js. The rules live in sync.js
// (VenstockSync.shellFetch), shared with the app and tested in tests/sync.unit.test.mjs.
importScripts("/sync.js");
const CACHE = "venstock-v21";
const SHELL = ["/", "/app.js", "/sync.js", "/tokens.css", "/style.css", "/fonts/archivo.woff2", "/fonts/fraunces.woff2",
  "/manifest.webmanifest", "/vendor/qrcode.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  // Network first; only successful answers are cached; 500/502/503/504 fall back to the cached copy; 404 and 403 are
  // shown as they are; offline uses the cache.
  e.respondWith(caches.open(CACHE).then((cache) => self.VenstockSync.shellFetch(e.request, { fetch: (r) => fetch(r), cache })));
});
