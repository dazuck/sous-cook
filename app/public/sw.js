// The kitchen app's service worker (slice B5b, B5.md B5–B6 and E2–E4).
// Hand-written: the app's Next/Turbopack build has no worker plugin here.
//
// - The build id comes in on the script URL (`/sw.js?build=<id>`, the app's
//   SOUS_BUILD_ID), so a new build is a new worker. Its cache is `sous-<id>`,
//   stamped with when its worker installed and when it activated
//   (`/__sous-build`).
// - A new worker installs and then waits: it never takes over by itself. The
//   page tells it to (SKIP_WAITING) once no cook page is on screen, so an
//   update never reloads a cook mid-recipe.
// - Activating keeps its own cache and the one of the build that was serving
//   until now (the most recently activated other), which a tab still on that
//   build reads its files from. A cache whose worker never activated (a build
//   that waited and was replaced) and every older one go, as do the pre-B5b
//   caches.
// - A lookup reads this build's cache first, then the others newest first by
//   their stamps (never by creation order). A build file found only in an
//   older build's cache is copied into this build's, so it outlives that
//   cache.
// - Navigations to /kitchen and /kitchen/queue/* are network-first, with the
//   kept page when the network fails. The hashed build files
//   (/_next/static/*) are cache-first; the fixed-name ones (/fonts/*, Sue's
//   confirmation clips in /sounds/*, the manifest and icon) are network-first,
//   so a deploy that changes them is seen at once. /api/* and everything
//   else goes straight to the network, never kept: the active cook offline
//   is drawn from the session the page keeps, not from a kept tRPC answer.
// - A cook page asks the worker to keep its own URL and the files it already
//   loaded (CACHE_URLS): a cook opened from the kitchen is a client-side
//   navigation, so its HTML never passed through here.

const BUILD = new URL(self.location.href).searchParams.get("build") || "dev";
const PREFIX = "sous-";
const CACHE = PREFIX + BUILD;
const STAMP = "/__sous-build";

async function readStamp(name) {
  try {
    const cache = await caches.open(name);
    const response = await cache.match(STAMP);
    return response ? await response.json() : null;
  } catch {
    return null;
  }
}

async function writeStamp(stamp) {
  const cache = await caches.open(CACHE);
  await cache.put(STAMP, new Response(JSON.stringify(stamp), { headers: { "content-type": "application/json" } }));
}

/** When a cache's build last mattered: its activation, else its install. */
function stampTime(stamp) {
  return stamp ? stamp.activatedAt || stamp.installedAt || 0 : 0;
}

/** This build's cache, then every other build's, newest first by stamp. */
async function cachesInOrder() {
  const names = (await caches.keys()).filter((n) => n.startsWith(PREFIX) && n !== CACHE);
  const stamped = await Promise.all(names.map(async (name) => ({ name, time: stampTime(await readStamp(name)) })));
  stamped.sort((a, b) => b.time - a.time);
  return [CACHE, ...stamped.map((s) => s.name)];
}

/** The kept answer for `request` and the cache it came from, or null. */
async function lookup(request) {
  for (const name of await cachesInOrder()) {
    const cache = await caches.open(name);
    const hit = await cache.match(request);
    if (hit) return { name, response: hit };
  }
  return null;
}

self.addEventListener("install", (event) => {
  event.waitUntil(writeStamp({ build: BUILD, installedAt: Date.now(), activatedAt: null }));
});

/** The builds of workers still to come on this registration, whose caches must stay. */
function pendingBuilds() {
  const builds = new Set();
  for (const worker of [self.registration.installing, self.registration.waiting]) {
    if (!worker) continue;
    builds.add(new URL(worker.scriptURL).searchParams.get("build") || "dev");
  }
  return builds;
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const own = (await readStamp(CACHE)) || { build: BUILD, installedAt: Date.now() };
      await writeStamp({ ...own, activatedAt: Date.now() });
      const names = await caches.keys();
      // The build that was serving until now: the most recently activated
      // other. A never-activated cache served no tab.
      let serving = null;
      let servingAt = 0;
      for (const name of names) {
        if (!name.startsWith(PREFIX) || name === CACHE) continue;
        const stamp = await readStamp(name);
        if (stamp && stamp.activatedAt && stamp.activatedAt > servingAt) {
          serving = name;
          servingAt = stamp.activatedAt;
        }
      }
      const keep = new Set([CACHE, serving]);
      for (const build of pendingBuilds()) keep.add(PREFIX + build);
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

function isCookNavigation(url) {
  return url.pathname === "/kitchen" || url.pathname.startsWith("/kitchen/queue/");
}

/** Hashed per build: a name never changes its content. */
function isHashedFile(url) {
  return url.pathname.startsWith("/_next/static/");
}

/** The same name across builds: its content can change with a deploy. */
function isFixedNameFile(url) {
  return (
    url.pathname.startsWith("/fonts/") ||
    url.pathname.startsWith("/sounds/") ||
    url.pathname === "/manifest.json" ||
    url.pathname === "/icon-192.png" ||
    url.pathname === "/icon-512.png" ||
    url.pathname === "/apple-touch-icon.png"
  );
}

/** Only a plain, same-origin, successful answer is kept. */
function keepable(response) {
  return response.ok && response.type === "basic" && !response.redirected;
}

async function keep(request, response) {
  const cache = await caches.open(CACHE);
  await cache.put(request, response);
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (keepable(response)) await keep(request, response.clone());
    return response;
  } catch (err) {
    const kept = await lookup(request);
    if (kept) return kept.response;
    throw err;
  }
}

async function cacheFirst(request) {
  const kept = await lookup(request);
  if (kept) {
    // Found only in an older build's cache: copy it into this build's, so it
    // outlives that cache when the next build activates.
    if (kept.name !== CACHE) await keep(request, kept.response.clone());
    return kept.response;
  }
  const response = await fetch(request);
  if (keepable(response)) await keep(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === STAMP) return;
  if (request.mode === "navigate" && isCookNavigation(url)) {
    event.respondWith(networkFirst(request));
  } else if (isHashedFile(url)) {
    event.respondWith(cacheFirst(request));
  } else if (isFixedNameFile(url)) {
    event.respondWith(networkFirst(request));
  }
});

/** How long a kept file may take to fetch before the worker gives up on it. */
const KEEP_TIMEOUT_MS = 10_000;

/** A signal that aborts after `ms`; the fallback is for a browser without AbortSignal.timeout. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  return controller.signal;
}

async function keepUrls(urls) {
  const own = await caches.open(CACHE);
  await Promise.all(
    urls.map(async (raw) => {
      try {
        const url = new URL(raw, self.location.origin);
        if (url.origin !== self.location.origin) return;
        if (!isCookNavigation(url) && !isHashedFile(url) && !isFixedNameFile(url)) return;
        url.hash = "";
        const request = new Request(url.href);
        if (isHashedFile(url)) {
          if (await own.match(request)) return;
          const kept = await lookup(request);
          if (kept) {
            await own.put(request, kept.response);
            return;
          }
        }
        const signal = timeoutSignal(KEEP_TIMEOUT_MS);
        try {
          const response = await fetch(request, { signal });
          if (keepable(response)) await own.put(request, response);
        } catch (err) {
          // A fetch that hangs is given up on, and said: a file that never
          // arrives would otherwise hold the message's waitUntil open.
          if (signal.aborted) console.warn("sous sw: gave up keeping " + url.pathname + " after " + KEEP_TIMEOUT_MS + "ms");
          throw err;
        }
      } catch {
        // Offline already, or the file is gone: nothing to keep.
      }
    }),
  );
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "CACHE_URLS" && Array.isArray(data.urls)) {
    event.waitUntil(keepUrls(data.urls.filter((u) => typeof u === "string")));
  }
});
