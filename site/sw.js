/*
 * Offline support for Minesweeper.
 *
 * The whole game is index.html + style.css + app.js and nothing else — there
 * is no API, no font CDN, no analytics — so "works offline" only needs those
 * three files plus the icons to survive a network outage.
 *
 * The strategy is NETWORK-FIRST for every same-origin GET, falling back to the
 * cache when the network fails. That is deliberately the slower of the two
 * obvious choices, and it is chosen because of how this can fail. A
 * cache-first worker serves yesterday's app.js after a deploy until something
 * invalidates it, so a bugfix can go out, appear green in the logs, and never
 * reach a returning player. Network-first cannot do that: online, the browser
 * always sees what nginx is serving right now, and the cache is consulted only
 * when the fetch genuinely fails. A game that silently serves yesterday's
 * bugfix is worse than a game with no offline mode.
 *
 * The cost of that choice is that the worker buys no speed, only offline. For
 * five small files off a local nginx behind Traefik, speed was never the
 * problem worth solving.
 *
 * VERSION therefore governs one thing only: when the install-time precache is
 * rebuilt and older caches are evicted. It is NOT what keeps clients fresh —
 * network-first does that — so forgetting to bump it cannot serve stale code.
 */
const VERSION = 'v1';
const CACHE = 'minesweeper-' + VERSION;

// Everything needed to open the game from a cold, offline start.
const PRECACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/favicon.svg',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll is atomic — one 404 would reject the whole install and leave
      // the old worker in charge, so each asset is added on its own and a
      // miss costs only that asset.
      .then((cache) => Promise.all(
        PRECACHE.map((url) => cache.add(url).catch((err) => {
          console.warn('[sw] precache miss: ' + url, err);
        }))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only this origin, and only GET. Anything else is passed straight through
  // to the network untouched.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // A daily-board link is /?d=YYYY-MM-DD, so a cache keyed on the full URL
  // would accumulate one copy of the same shell per date anybody visits.
  // Those navigations go to the network and, offline, fall through to the
  // cached /index.html — which is all they ever needed, since the date is
  // read from the address bar rather than from the response.
  if (url.search) {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match('/index.html').then((hit) => hit || Response.error())
      )
    );
    return;
  }

  event.respondWith(
    // `fetch(req)` can be satisfied by the browser's HTTP cache before it
    // reaches nginx. `no-store` makes network-first mean the network, not
    // merely a cache that happens to sit below this worker.
    fetch(req, { cache: 'no-store' })
      .then(async (res) => {
        // Opaque and error responses are not worth storing; a cached 404 would
        // outlive the deploy that fixed it.
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
          return res;
        }
        // A reachable server that is answering badly — the container is down
        // and Traefik is returning its own 404, say — is not the same as a
        // successful response, and fetch does not throw for it. Prefer a known
        // good cached copy over handing the player an error page. Anything we
        // have never cached still gets the real response, so this cannot mask
        // a genuine 404 for a URL that was never part of the app.
        const hit = await caches.match(req);
        return hit || res;
      })
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return hit;
          // A navigation to any path in scope should still open the game
          // rather than the browser's offline dinosaur.
          if (req.mode === 'navigate') return caches.match('/index.html');
          return Response.error();
        })
      )
  );
});
