/*
 * Checks the two PWA claims against the live site in a real Chromium: that the
 * app is installable, and that it is genuinely playable with no server.
 *
 * Run it through tools/verify-offline.sh, which sequences the phases and stops
 * the container between them. The phases are separate processes on purpose —
 * the proof needs the origin server down while the browser loads the page, and
 * the browser has to already be primed when that happens.
 *
 *   node /tools/verify-pwa.js <phase> <url>      phase = online | offline | fresh
 *
 * WHY NOT context.setOffline: it does not apply to fetches a service worker
 * makes. An earlier version of this file used it, and its own control check —
 * "the network is genuinely down" — failed while every offline assertion
 * around it passed, which is exactly the shape of a test that proves nothing.
 * Stopping the container removes the ambiguity: if a board still renders, it
 * came out of the Cache API, because there is nothing else left to serve it.
 *
 * The profile is persistent (--user-data-dir equivalent) so the service worker
 * registration and its Cache Storage survive from one phase to the next, the
 * way they would for a real returning player.
 */
let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { chromium = require('playwright-core').chromium; }

const PHASE = process.argv[2] || 'online';
const URL_ = process.argv[3] || 'https://minesweeper.ichabod-crane.net/';
const OUT = process.env.OUT_DIR || '/proof';
const PROFILE = process.env.PROFILE_DIR || '/profile';

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : ''));
  } else {
    failures.push(name + (detail ? '  [' + detail + ']' : ''));
    console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : ''));
  }
}

const state = (page) => page.evaluate(() => window.minesweeper.state());

/* ------------------------------------------------------------------ */

async function online(context, page) {
  console.log('\n== Manifest — ' + URL_);
  const resp = await page.goto(URL_, { waitUntil: 'load', timeout: 45000 });
  check('page returns 200', resp.status() === 200, 'status ' + resp.status());

  const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
  check('index.html links a manifest', !!manifestHref, String(manifestHref));

  const manifestUrl = new URL(manifestHref, page.url()).href;
  const mres = await context.request.get(manifestUrl);
  check('manifest returns 200', mres.status() === 200, 'status ' + mres.status());
  check('manifest is served as a JSON type',
    /json/.test(mres.headers()['content-type'] || ''),
    mres.headers()['content-type']);

  let manifest = null;
  try {
    manifest = JSON.parse(await mres.text());
    check('manifest parses as JSON', true);
  } catch (e) {
    check('manifest parses as JSON', false, e.message);
  }

  if (manifest) {
    for (const field of ['name', 'start_url', 'display', 'icons']) {
      check('manifest has ' + field, manifest[field] !== undefined,
        JSON.stringify(manifest[field]));
    }
    check('display is a standalone-ish mode',
      ['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display),
      manifest.display);

    // Chrome's install criteria want at least a 192 and a 512 PNG.
    const sizes = (manifest.icons || []).map((i) => i.sizes);
    check('icons include 192x192', sizes.includes('192x192'), sizes.join(' '));
    check('icons include 512x512', sizes.includes('512x512'), sizes.join(' '));
    check('a maskable icon is declared',
      (manifest.icons || []).some((i) => /maskable/.test(i.purpose || '')));

    for (const icon of manifest.icons || []) {
      const ires = await context.request.get(new URL(icon.src, manifestUrl).href);
      const body = await ires.body();
      // PNG magic number — proves it is a real bitmap, not an SVG renamed.
      const isPng = body.length > 8 && body[0] === 0x89 && body[1] === 0x50 &&
        body[2] === 0x4e && body[3] === 0x47;
      // IHDR carries width and height as big-endian uint32 at offsets 16/20.
      const w = isPng ? body.readUInt32BE(16) : 0;
      const h = isPng ? body.readUInt32BE(20) : 0;
      check('icon ' + icon.src + ' is a PNG of ' + icon.sizes,
        ires.status() === 200 && isPng && (w + 'x' + h) === icon.sizes,
        'status ' + ires.status() + ', ' + w + 'x' + h);
    }
  }

  check('a theme-color is set',
    !!(await page.getAttribute('meta[name="theme-color"]', 'content')));

  console.log('\n== Service worker');
  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { ok: false, why: 'unsupported' };
    const reg = await navigator.serviceWorker.ready;
    // ready resolves on activation; controller is what proves it owns *this*
    // page, which clients.claim() is there to make true on the first load.
    for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return {
      ok: true, scope: reg.scope, active: !!reg.active,
      controlling: !!navigator.serviceWorker.controller,
    };
  });
  check('a service worker is registered and active', sw.ok && sw.active, JSON.stringify(sw));
  check('the worker controls the page', sw.controlling === true);
  check('worker scope is the whole origin', (sw.scope || '').endsWith('/'), sw.scope);

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const out = {};
    for (const n of names) {
      out[n] = (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname);
    }
    return out;
  });
  const entries = Object.values(cached).flat();
  check('the worker precached the app', entries.length >= 4, entries.join(' '));
  for (const need of ['/index.html', '/app.js', '/style.css']) {
    check('precache holds ' + need, entries.includes(need));
  }
  console.log('\n  profile primed — the container can be stopped now');
}

async function offline(context, page) {
  console.log('\n== Offline — origin server stopped, loading from the profile');

  // Confirm the server really is gone before trusting what renders.
  const probe = await context.request.get(URL_ + '?probe=' + Date.now(), {
    failOnStatusCode: false, timeout: 20000,
  }).then((r) => 'status ' + r.status()).catch((e) => 'threw: ' + e.message.split('\n')[0]);
  check('the origin is not serving the app',
    !/status 200/.test(probe), probe);

  await page.goto(URL_, { waitUntil: 'load', timeout: 45000 });
  check('the page still loads with the server down', true, page.url());
  check('it is the real game, not an error page',
    (await page.title()) === 'Minesweeper', await page.title());
  check('the service worker served it',
    await page.evaluate(() => !!navigator.serviceWorker.controller));
  check('stylesheet survived', await page.evaluate(
    () => getComputedStyle(document.querySelector('.title')).fontFamily !== ''));
  check('game script initialised', await page.evaluate(() => !!window.minesweeper));

  console.log('\n== Offline play — real clicks, server still down');
  await page.click('.diff-btn[data-difficulty="beginner"]');
  let s = await state(page);
  check('difficulty switch works', s.cols === 9 && s.rows === 9 && s.mines === 10,
    s.cols + 'x' + s.rows + '/' + s.mines);
  check('board rendered', (await page.locator('.board .cell').count()) === 81);

  await page.locator('.cell[data-i="40"]').click();
  s = await state(page);
  check('first click seeds the mines', s.seeded);
  check('first click is safe', !s.over, 'over=' + s.over);
  check('first click opens a region', s.revealed > 1, s.revealed + ' squares');

  // Flagging, then play it out to a win — offline, with real clicks.
  const firstHidden = await page.evaluate(() => {
    const els = document.querySelectorAll('.cell');
    for (let i = 0; i < els.length; i++) {
      if (!els[i].classList.contains('revealed')) return i;
    }
    return -1;
  });
  await page.locator('.cell[data-i="' + firstHidden + '"]').click({ button: 'right' });
  check('right-click flags offline',
    (await page.locator('.cell[data-i="' + firstHidden + '"]').textContent()) === '🚩');
  await page.locator('.cell[data-i="' + firstHidden + '"]').click({ button: 'right' });

  let guard = 0;
  for (;;) {
    if (guard++ > 200) throw new Error('offline win loop did not terminate');
    const next = await page.evaluate(() => {
      const st = window.minesweeper.state();
      if (st.over) return -1;
      const els = document.querySelectorAll('.cell');
      for (let i = 0; i < els.length; i++) {
        if (!els[i].classList.contains('revealed') && !window.minesweeper.mineAt(i)) return i;
      }
      return -1;
    });
    if (next < 0) break;
    await page.locator('.cell[data-i="' + next + '"]').click();
  }
  s = await state(page);
  check('a full game is WON with no server', s.over && s.won === true, 'won=' + s.won);
  check('winning face is 😎', (await page.locator('#reset').textContent()) === '😎');
  check('best time was recorded offline',
    (await page.locator('#best-time').textContent()) !== '—',
    await page.locator('#best-time').textContent());

  await page.screenshot({ path: OUT + '/07-offline-win.png' });
  console.log('  -> screenshot 07-offline-win.png');
}

async function fresh(context, page) {
  console.log('\n== Back online — the cache must not win');
  await page.goto(URL_, { waitUntil: 'load', timeout: 45000 });
  check('the page recovers when the server returns',
    await page.evaluate(() => !!window.minesweeper));
  check('the worker is still in charge',
    await page.evaluate(() => !!navigator.serviceWorker.controller));

  // Network-first means an online load must reach nginx, not the cache.
  const r = await page.evaluate(async () => {
    const res = await fetch('/app.js', { cache: 'no-store' });
    return { ok: res.ok, server: res.headers.get('server') || '', len: (await res.text()).length };
  });
  check('requests reach the server, not the cache',
    r.ok && /nginx/i.test(r.server), JSON.stringify(r));

  // The kill condition, tested directly: a file changed on the server while
  // this profile held a cached copy must be the version the page now sees.
  const marker = process.env.FRESH_MARKER;
  if (marker) {
    const got = await page.evaluate(async () => (await fetch('/style.css')).text());
    check('a post-cache deploy is picked up, not shadowed by the cache',
      got.includes(marker), marker + (got.includes(marker) ? ' found' : ' MISSING'));
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE, {
    viewport: { width: 1200, height: 860 },
  });
  const page = context.pages()[0] || await context.newPage();

  const phases = { online, offline, fresh };
  if (!phases[PHASE]) throw new Error('unknown phase: ' + PHASE);
  await phases[PHASE](context, page);

  await context.close();

  console.log('\n' + '='.repeat(60));
  console.log(PHASE + ': ' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('phase "' + PHASE + '" passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
