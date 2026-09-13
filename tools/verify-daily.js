/*
 * Proves the Daily board is actually daily: one shared minefield per UTC date,
 * reproduced from nothing but the date, and not at the cost of random mode.
 *
 * The claim under test is determinism across *independent page loads*, so every
 * comparison below is between two fresh browser contexts — not two newGame()
 * calls in one page, which would share a warm module and prove much less. Each
 * context gets its own storage, so nothing carries over but the seed.
 *
 *   docker run --rm --ipc=host \
 *     -v /srv/ichabod/apps/minesweeper/tools:/tools:ro \
 *     -v /srv/ichabod/apps/minesweeper/.verify/node_modules:/node_modules:ro \
 *     -v /srv/ichabod/apps/minesweeper/proof:/proof \
 *     mcr.microsoft.com/playwright:v1.55.0-noble \
 *     node /tools/verify-daily.js https://minesweeper.ichabod-crane.net/
 *
 * The node_modules mount is not optional — see the header of verify.js.
 */
let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { chromium = require('playwright-core').chromium; }

const URL = process.argv[2] || 'https://minesweeper.ichabod-crane.net/';
const OUT = process.env.OUT_DIR || '/proof';

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
const layout = (page) => page.evaluate(() => window.minesweeper.layout());
const cell = (page, i) => page.locator('.cell[data-i="' + i + '"]');

function joinUrl(base, query) {
  return base.replace(/\?.*$/, '').replace(/\/$/, '/') + query;
}

/*
 * One independent load. A brand new context is a brand new browser as far as
 * storage, cache and page script are concerned, which is what makes "two
 * players" an honest description of two of these.
 */
async function freshLoad(browser, url, consoleErrors) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => consoleErrors.push('requestfailed: ' + r.url()));
  const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  return { context, page, status: resp.status() };
}

/*
 * The layout a load ends up with *after a forced first click*, plus the state
 * at that moment. Forcing the click matters: in random mode the mines are not
 * placed until it happens, so comparing before it would compare two empty
 * boards and pass for the wrong reason.
 */
async function layoutAfterFirstClick(browser, url, clickIdx, consoleErrors) {
  const { context, page } = await freshLoad(browser, url, consoleErrors);
  await cell(page, clickIdx).click();
  const out = { layout: await layout(page), state: await state(page) };
  await context.close();
  return out;
}

const mineCount = (l) => l.split('').filter((c) => c === '1').length;

async function main() {
  const browser = await chromium.launch();
  const consoleErrors = [];

  const dailyUrl = (d, level) =>
    joinUrl(URL, '?d=' + d + (level ? '&level=' + level : ''));

  /* ------------- 0. the mode exists and is off by default ------------- */

  console.log('\n== Default load is still random mode');
  {
    const { context, page, status } = await freshLoad(browser, URL, consoleErrors);
    check('page returns 200', status === 200, 'status ' + status);
    check('mode toggle is present', (await page.locator('.mode-btn').count()) === 2);
    const s = await state(page);
    check('a plain visit is NOT on the daily board', s.mode === 'random', 'mode=' + s.mode);
    check('a plain visit deals nothing up front', s.seeded === false && s.revealed === 0,
      'seeded=' + s.seeded + ' revealed=' + s.revealed);
    check('the daily banner is hidden in random mode',
      await page.locator('#daily-line').isHidden());
    check('best label reads Best in random mode',
      (await page.locator('#best-label').textContent()) === 'Best');
    await context.close();
  }

  /* ------------- 1. same date, two loads, identical board ------------- */

  console.log('\n== Two independent loads of the same date deal the same board');
  const DATE_A = '2026-03-14';
  const first = 40;

  const a1 = await layoutAfterFirstClick(browser, dailyUrl(DATE_A, 'beginner'), first, consoleErrors);
  const a2 = await layoutAfterFirstClick(browser, dailyUrl(DATE_A, 'beginner'), first, consoleErrors);

  check('load 1 is in daily mode on ' + DATE_A,
    a1.state.mode === 'daily' && a1.state.date === DATE_A,
    a1.state.mode + ' ' + a1.state.date);
  check('load 2 is in daily mode on ' + DATE_A,
    a2.state.mode === 'daily' && a2.state.date === DATE_A,
    a2.state.mode + ' ' + a2.state.date);
  check('the board is really a board (10 mines placed)',
    mineCount(a1.layout) === 10, mineCount(a1.layout) + ' mines');
  check('the two loads produced an IDENTICAL mine layout',
    a1.layout === a2.layout,
    a1.layout === a2.layout ? 'match' : a1.layout + ' vs ' + a2.layout);
  check('the two loads opened on the same square',
    a1.state.anchor === a2.state.anchor,
    a1.state.anchor + ' vs ' + a2.state.anchor);
  check('the two loads agree on the seed',
    a1.state.seed === a2.state.seed, a1.state.seed);
  check('the opening square is not a mine',
    a1.layout[a1.state.anchor] === '0', 'anchor ' + a1.state.anchor);
  check('the daily board opens a region before the player touches it',
    a1.state.revealed > 1, a1.state.revealed + ' squares opened');

  /* ------------- 2. a different date is a different board ------------- */

  console.log('\n== A different UTC date deals a different board');
  const DATE_B = '2026-03-15';
  const b1 = await layoutAfterFirstClick(browser, dailyUrl(DATE_B, 'beginner'), first, consoleErrors);

  check('the other date also deals 10 mines',
    mineCount(b1.layout) === 10, mineCount(b1.layout) + ' mines');
  check(DATE_B + ' differs from ' + DATE_A,
    b1.layout !== a1.layout, b1.layout === a1.layout ? 'IDENTICAL' : 'different');
  check('the seed changed with the date',
    b1.state.seed !== a1.state.seed, b1.state.seed);

  // And the date override inside one page agrees with the URL — the same board
  // reached two different ways is the same board.
  {
    const { context, page } = await freshLoad(browser, dailyUrl(DATE_A, 'beginner'), consoleErrors);
    const viaUrl = await layout(page);
    await page.evaluate((d) => window.minesweeper.setDailyDate(d), DATE_B);
    const viaApi = await layout(page);
    check('setDailyDate re-deals to a different board', viaApi !== viaUrl);
    check('setDailyDate reproduces the URL board for that date',
      viaApi === b1.layout, 'matches the ' + DATE_B + ' deal');
    await page.evaluate((d) => window.minesweeper.setDailyDate(d), DATE_A);
    check('and deals its way back to the first board', (await layout(page)) === viaUrl);
    await context.close();
  }

  /* ------------- 3. difficulty gets its own daily board ------------- */

  console.log('\n== Each difficulty has its own board for the date');
  const e1 = await layoutAfterFirstClick(browser, dailyUrl(DATE_A, 'expert'), 240, consoleErrors);
  const e2 = await layoutAfterFirstClick(browser, dailyUrl(DATE_A, 'expert'), 240, consoleErrors);
  check('expert daily is 30x16/99',
    e1.state.cols === 30 && e1.state.rows === 16 && e1.state.mines === 99,
    e1.state.cols + 'x' + e1.state.rows + '/' + e1.state.mines);
  check('expert daily places exactly 99 mines',
    mineCount(e1.layout) === 99, mineCount(e1.layout) + ' mines');
  check('expert daily is reproducible too', e1.layout === e2.layout);
  check('expert daily is not the beginner deal', e1.layout !== a1.layout);

  /* ------------- 4. random mode is untouched ------------- */

  console.log('\n== Random mode still deals a different board every time');
  const r = [];
  for (let i = 0; i < 3; i++) {
    r.push((await layoutAfterFirstClick(browser, URL, first, consoleErrors)).layout);
  }
  check('random load 1 differs from load 2', r[0] !== r[1]);
  check('random load 2 differs from load 3', r[1] !== r[2]);
  check('random load 1 differs from load 3', r[0] !== r[2]);
  check('random deals still hold 10 mines',
    r.every((l) => mineCount(l) === 10), r.map(mineCount).join(','));
  check('random mode is not secretly the daily board',
    r.every((l) => l !== a1.layout));

  /* ------------- 5. playing the daily through to a win ------------- */

  console.log('\n== Playing today\'s daily to a win, with real clicks');
  {
    const { context, page } = await freshLoad(browser, joinUrl(URL, '?mode=daily'), consoleErrors);
    const opening = await state(page);
    const today = new Date().toISOString().slice(0, 10);
    check('?mode=daily lands on today (UTC)', opening.date === today,
      opening.date + ' vs ' + today);
    check('today\'s board is already opened on its anchor',
      opening.revealed > 0 && opening.anchor >= 0,
      'revealed=' + opening.revealed + ' anchor=' + opening.anchor);
    check('the daily banner is showing', await page.locator('#daily-line').isVisible());
    check('the banner names the date',
      (await page.locator('#daily-date').textContent()) === today);
    check('best label reads Today in daily mode',
      (await page.locator('#best-label').textContent()) === 'Today');
    check('no record for today yet', (await page.locator('#best-time').textContent()) === '—');
    check('the clock has not started on a move the player did not make',
      (await page.locator('#timer').textContent()) === '000',
      await page.locator('#timer').textContent());

    await page.screenshot({ path: OUT + '/08-daily-opening.png' });
    console.log('  -> screenshot 08-daily-opening.png');

    // Make the first move, then sit on it. The clock starts on the player's
    // first click and not before, so dead time only lands on the clock if it
    // is spent after that click — which is exactly the property being checked.
    const opener = await page.evaluate(() => {
      const els = document.querySelectorAll('.cell');
      for (let i = 0; i < els.length; i++) {
        if (!els[i].classList.contains('revealed') && !window.minesweeper.mineAt(i)) return i;
      }
      return -1;
    });
    check('a safe square remains to open the game with', opener >= 0, 'index ' + opener);
    await cell(page, opener).click();
    await page.waitForTimeout(1600);

    let guard = 0;
    for (;;) {
      if (guard++ > 200) throw new Error('daily win loop did not terminate');
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
      await cell(page, next).click();
    }

    const s = await state(page);
    check('the daily is WON', s.won === true, 'won=' + s.won);
    const text = await page.locator('#status').textContent();
    check('the win names the date', text.includes(today), text);
    const secs = Number((/in (\d+) seconds/.exec(text) || [])[1]);
    check('the clock ran while the player played', secs >= 1, secs + 's');
    check('today\'s time is recorded', s.daily && s.daily.secs === secs,
      JSON.stringify(s.daily));
    check('the recorded time is shown', (await page.locator('#best-time').textContent()) !== '—',
      await page.locator('#best-time').textContent());

    const share = await page.evaluate(() => window.minesweeper.shareText());
    check('a shareable result appears on a win', typeof share === 'string' && share.length > 0);
    check('the share line carries the date', share.includes(today), share);
    check('the share line carries the time', share.includes(secs + 's'), share);
    check('the share line carries a link back to this exact board',
      share.includes('?d=' + today + '&level=beginner'), share);

    // The daily record must not have leaked into the lifetime best-times store.
    const bests = await page.evaluate(() => window.minesweeper.bests());
    check('a daily win does NOT touch the random-mode records',
      Object.keys(bests).length === 0, JSON.stringify(bests));

    await page.screenshot({ path: OUT + '/09-daily-win.png' });
    console.log('  -> screenshot 09-daily-win.png');
    await context.close();
  }

  /* ------------- 6. the toggle works by hand ------------- */

  console.log('\n== The toggle switches modes and the URL follows');
  {
    const { context, page } = await freshLoad(browser, URL, consoleErrors);
    await page.click('.mode-btn[data-mode="daily"]');
    let s = await state(page);
    check('clicking Daily enters daily mode', s.mode === 'daily', 'mode=' + s.mode);
    check('clicking Daily deals the board immediately', s.seeded && s.revealed > 0,
      'seeded=' + s.seeded + ' revealed=' + s.revealed);
    check('the URL now carries the date, so it can be shared',
      page.url().includes('?d=' + s.date), page.url());

    await page.click('.mode-btn[data-mode="random"]');
    s = await state(page);
    check('clicking Random leaves daily mode', s.mode === 'random', 'mode=' + s.mode);
    check('random mode waits for the first click again',
      !s.seeded && s.revealed === 0, 'seeded=' + s.seeded);
    check('the URL drops the date', !page.url().includes('?d='), page.url());
    await context.close();
  }

  /* ------------- 7. junk input degrades quietly ------------- */

  console.log('\n== A nonsense date falls back to today rather than breaking');
  {
    const { context, page } = await freshLoad(
      browser, joinUrl(URL, '?d=2026-02-31'), consoleErrors);
    const s = await state(page);
    const today = new Date().toISOString().slice(0, 10);
    check('an impossible calendar date is rejected', s.date === today,
      s.date + ' vs ' + today);
    check('the game still initialised', await page.evaluate(() => !!window.minesweeper));
    check('setDailyDate rejects junk',
      (await page.evaluate(() => window.minesweeper.setDailyDate('not-a-date'))) === false);
    await context.close();
  }

  check('no console or network errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  await browser.close();

  console.log('\n' + '='.repeat(56));
  console.log('passed: ' + passed + '   failed: ' + failures.length);
  if (failures.length) {
    failures.forEach((f) => console.log('  FAILED: ' + f));
    process.exit(1);
  }
  console.log('ALL CHECKS PASSED');
}

main().catch((e) => { console.error('\nFATAL: ' + e.stack); process.exit(1); });
