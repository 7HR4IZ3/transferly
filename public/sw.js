// Transferly service worker: keeps a full offline copy of the app.
//
// - Page ("/"): network first (fresh deploys win), cached copy when offline.
// - /_next/static/*: content-hashed, so cache first. Every time the page is
//   fetched online, the files it references are cached and stale ones removed.
// - /api/*: never cached (pairing must be live).

const VERSION = "v3";
const PAGE_CACHE = "transferly-page-" + VERSION;
const ASSET_CACHE = "transferly-assets-" + VERSION;
const EXTRA = ["/manifest.webmanifest", "/icon.svg"];
const NETWORK_TIMEOUT_MS = 4000;

function assetUrls(html) {
  const urls = new Set();
  for (const match of html.matchAll(/\/_next\/static\/[^"'\s)\\]+/g)) urls.add(match[0]);
  return [...urls];
}

/** Cache the page plus everything it references; drop assets no longer used. */
async function storePage(response) {
  const html = await response.clone().text();
  const page = await caches.open(PAGE_CACHE);
  await page.put("/", response.clone());

  const wanted = new Set([...assetUrls(html), ...EXTRA].map((path) => new URL(path, self.location.origin).href));
  const assets = await caches.open(ASSET_CACHE);
  const cached = await assets.keys();
  const have = new Set(cached.map((request) => request.url));
  await Promise.all(
    [...wanted]
      .filter((url) => !have.has(url))
      .map((url) =>
        fetch(url, { cache: "no-cache" })
          .then((res) => (res.ok ? assets.put(url, res) : undefined))
          .catch(() => undefined),
      ),
  );
  await Promise.all(cached.filter((request) => !wanted.has(request.url)).map((request) => assets.delete(request)));
}

function fetchWithTimeout(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS);
    fetch(request).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    fetch("/", { cache: "no-cache" })
      .then((response) => (response.ok ? storePage(response) : undefined))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== PAGE_CACHE && key !== ASSET_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetchWithTimeout(request)
        .then((response) => {
          if (response.ok && url.pathname === "/") event.waitUntil(storePage(response.clone()));
          return response;
        })
        .catch(async () => (await caches.match("/", { cacheName: PAGE_CACHE })) || Response.error()),
    );
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || EXTRA.includes(url.pathname)) {
    event.respondWith(
      caches.match(request, { cacheName: ASSET_CACHE }).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              event.waitUntil(caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy)));
            }
            return response;
          }),
      ),
    );
  }
});
