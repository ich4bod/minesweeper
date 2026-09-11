/*
 * Acceptance test for persisted per-difficulty best times.
 *
 * Same rule as verify.js: every reveal is a real click on a real cell.
 * window.minesweeper is used only to *read* state and to decide which cell to
 * click next, never to reveal on the game's behalf. localStorage is read
 * through the page, so what is asserted is what a browser actually stored.
 *
 *   docker run --rm --ipc=host \
 *     -v /srv/ichabod/apps/minesweeper/tools:/tools:ro \
 *     -v /srv/ichabod/apps/minesweeper/.verify/node_modules:/node_modules:ro \
 *     -v /srv/ichabod/apps/minesweeper/proof:/proof \
 *     mcr.microsoft.com/playwright:v1.55.0-noble \
 *     node /tools/verify-best.js https://minesweeper.ichabod-crane.net/
 */
let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { chromium = require('playwright-core').chromium; }

const URL = process.argv[2] || 'https://minesweeper.ichabod-crane.net/';
const OUT = process.env.OUT_DIR || '/proof';
const KEY = 'minesweeper.best.v1';

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

const state   = (page) => page.evaluate(() => window.minesweeper.state());
const cell    = (page, i) => page.locator('.cell[data-i="' + i + '"]');
const shown   = (page) => page.locator('#best-time').textContent();
const status  = (page) => page.locator('#status').textContent();
const stored  = (page) => page.evaluate((k) => {
  try { return JSON.parse(window.localStorage.getItem(k)) || {}; } catch (e) { return {}; }
}, KEY);

// Seconds the game itself reported in the win line, so the assertion compares
// the stored record against the game's own number rather than the harness's.
function announcedSeconds(text) {
  const m = /in (\d+) seconds/.exec(text || '');
  return m ? Number(m[1]) : null;
}

/*
 * Plays one board to a win with real clicks. `holdMs` is dead time inserted
 * after the opening click, which is how a slow win is produced on demand —
 * the clock is wall-clock, so waiting is the only honest way to spend it.
 */
async function playToWin(page, firstIdx, holdMs) {
  await cell(page, firstIdx).click();
  if (holdMs) await page.waitForTimeout(holdMs);

  const safe = await page.evaluate(() => {
    const st = window.minesweeper.state();
    const out = [];
    for (let i = 0; i < st.cols * st.rows; i++) {
      if (!window.minesweeper.mineAt(i)) out.push(i);
    }
    return out;
  });

  // Clicking an already-revealed square is a no-op here: chord() only fires
  // when the flag count matches the number, and nothing is flagged.
  for (const i of safe) {
    if ((await page.evaluate(() => window.minesweeper.state().over))) break;
    const isHidden = await page.evaluate(
      (n) => !document.querySelector('.cell[data-i="' + n + '"]').classList.contains('revealed'),
      i
    );
    if (isHidden) await cell(page, i).click();
  }
  return state(page);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  console.log('\n== Loading ' + URL + ' with empty storage');
  await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
  await page.evaluate((k) => window.localStorage.removeItem(k), KEY);
  await page.reload({ waitUntil: 'load' });

  check('best row is present', await page.locator('.best').count() === 1);
  check('no record reads as an em dash', (await shown(page)) === '—', await shown(page));
  check('storage starts empty', Object.keys(await stored(page)).length === 0);

  /* ---------------- beginner: first record ---------------- */

  console.log('\n== Beginner — a slow win sets the first record');
  let s = await playToWin(page, 40, 3200);
  check('game is WON', s.won === true, 'won=' + s.won);

  let text = await status(page);
  let secs = announcedSeconds(text);
  check('win took real time on the clock', secs !== null && secs >= 3, text);
  check('win line announces a new best', / A new best\./.test(text), text);

  let bests = await stored(page);
  check('beginner best is stored', bests.beginner === secs, JSON.stringify(bests));
  const mmss = (n) => Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
  check('best renders as M:SS', (await shown(page)) === mmss(secs),
    'shows ' + (await shown(page)) + ', expected ' + mmss(secs));
  const slowBeginner = secs;
  await page.screenshot({ path: OUT + '/04-best-first-record.png' });
  console.log('  -> screenshot 04-best-first-record.png');

  /* ---------------- beginner: a faster win replaces it ---------------- */

  console.log('\n== Beginner — a faster win replaces the record');
  await page.click('#reset');
  check('best survives a new game on the same difficulty',
    (await shown(page)) === mmss(slowBeginner), await shown(page));

  s = await playToWin(page, 40, 0);
  check('game is WON', s.won === true);
  text = await status(page);
  const fastBeginner = announcedSeconds(text);
  check('the fast win really was faster', fastBeginner < slowBeginner,
    fastBeginner + 's vs ' + slowBeginner + 's');
  check('faster win announces a new best', / A new best\./.test(text), text);
  bests = await stored(page);
  check('stored record improved', bests.beginner === fastBeginner, JSON.stringify(bests));
  check('display shows the improved time', (await shown(page)) === mmss(fastBeginner));

  /* ---------------- beginner: a slower win does NOT replace it ---------------- */

  console.log('\n== Beginner — a slower win leaves the record alone');
  await page.click('#reset');
  s = await playToWin(page, 40, 3200);
  check('game is WON', s.won === true);
  text = await status(page);
  const slowerAgain = announcedSeconds(text);
  check('this win was slower than the record', slowerAgain > fastBeginner,
    slowerAgain + 's vs record ' + fastBeginner + 's');
  check('slower win does NOT claim a new best', !/ A new best\./.test(text), text);
  bests = await stored(page);
  check('record is unchanged by a slower win',
    bests.beginner === fastBeginner, JSON.stringify(bests));
  check('display still shows the record', (await shown(page)) === mmss(fastBeginner));

  /* ---------------- a loss must not touch the record ---------------- */

  console.log('\n== Beginner — a loss does not touch the record');
  await page.click('#reset');
  await cell(page, 40).click();
  await page.waitForTimeout(1200);
  const mineIdx = await page.evaluate(() => {
    const st = window.minesweeper.state();
    for (let i = 0; i < st.cols * st.rows; i++) if (window.minesweeper.mineAt(i)) return i;
    return -1;
  });
  await cell(page, mineIdx).click();
  s = await state(page);
  check('game is LOST', s.over === true && s.won === false, 'won=' + s.won);
  bests = await stored(page);
  check('record unchanged after a loss', bests.beginner === fastBeginner, JSON.stringify(bests));
  check('display unchanged after a loss', (await shown(page)) === mmss(fastBeginner));

  /* ---------------- the other two difficulties ---------------- */

  const others = [
    { name: 'intermediate', first: 136 },
    { name: 'expert',       first: 240 },
  ];
  const recorded = { beginner: fastBeginner };

  for (const d of others) {
    console.log('\n== ' + d.name + ' — keeps its own record');
    await page.click('.diff-btn[data-difficulty="' + d.name + '"]');
    check(d.name + ' starts with no record of its own', (await shown(page)) === '—',
      await shown(page));

    s = await playToWin(page, d.first, 0);
    check(d.name + ' game is WON', s.won === true, 'won=' + s.won);
    text = await status(page);
    const t = announcedSeconds(text);
    check(d.name + ' win announces a new best', / A new best\./.test(text), text);
    bests = await stored(page);
    check(d.name + ' best is stored', bests[d.name] === t, JSON.stringify(bests));
    check(d.name + ' best is displayed', (await shown(page)) === mmss(t),
      await shown(page));
    recorded[d.name] = t;
    await page.screenshot({ path: OUT + '/0' + (5 + others.indexOf(d)) + '-best-' + d.name + '.png' });
    console.log('  -> screenshot 0' + (5 + others.indexOf(d)) + '-best-' + d.name + '.png');
  }

  /* ---------------- records are per difficulty, and survive a reload ---------------- */

  console.log('\n== Records are per-difficulty and survive a reload');
  bests = await stored(page);
  check('all three difficulties are stored separately',
    bests.beginner === recorded.beginner &&
    bests.intermediate === recorded.intermediate &&
    bests.expert === recorded.expert,
    JSON.stringify(bests));

  await page.reload({ waitUntil: 'load' });
  bests = await stored(page);
  check('storage survived the reload',
    bests.beginner === recorded.beginner &&
    bests.intermediate === recorded.intermediate &&
    bests.expert === recorded.expert,
    JSON.stringify(bests));

  // The page opens on beginner, so that is the record it should be showing.
  check('reload shows the beginner record', (await shown(page)) === mmss(recorded.beginner),
    await shown(page));

  for (const name of ['intermediate', 'expert', 'beginner']) {
    await page.click('.diff-btn[data-difficulty="' + name + '"]');
    check('switching to ' + name + ' shows its own record after reload',
      (await shown(page)) === mmss(recorded[name]),
      'shows ' + (await shown(page)) + ', expected ' + mmss(recorded[name]));
  }

  /* ---------------- the change did not disturb the timer ---------------- */

  console.log('\n== Timer and difficulty switching still behave');
  await page.click('.diff-btn[data-difficulty="beginner"]');
  check('new difficulty resets the timer to 000',
    (await page.locator('#timer').textContent()) === '000',
    await page.locator('#timer').textContent());
  s = await state(page);
  check('new difficulty resets game state', !s.over && !s.seeded && s.revealed === 0);

  await cell(page, 40).click();
  await page.waitForTimeout(2400);
  const running = await page.locator('#timer').textContent();
  check('timer runs once the game starts', Number(running) >= 2, 'timer reads ' + running);

  await page.click('.diff-btn[data-difficulty="expert"]');
  check('switching difficulty mid-game stops and resets the timer',
    (await page.locator('#timer').textContent()) === '000',
    await page.locator('#timer').textContent());
  await page.waitForTimeout(1200);
  check('stopped timer stays stopped',
    (await page.locator('#timer').textContent()) === '000',
    await page.locator('#timer').textContent());

  /* ---------------- corrupt storage must not break the game ---------------- */

  console.log('\n== Corrupt storage degrades quietly');
  await page.evaluate((k) => window.localStorage.setItem(k, 'not json at all'), KEY);
  await page.reload({ waitUntil: 'load' });
  check('game still initialises with corrupt storage',
    await page.evaluate(() => !!window.minesweeper));
  check('corrupt storage reads as no record', (await shown(page)) === '—', await shown(page));
  s = await playToWin(page, 40, 0);
  check('a win still works with corrupt storage', s.won === true);
  bests = await stored(page);
  check('corrupt storage is overwritten by a real record',
    typeof bests.beginner === 'number', JSON.stringify(bests));

  check('no console or page errors', consoleErrors.length === 0, consoleErrors.join(' | '));

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
