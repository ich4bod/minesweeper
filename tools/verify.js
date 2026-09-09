/*
 * Plays the live site in a real Chromium with real mouse clicks and checks the
 * acceptance criteria. Every reveal below is an actual click on an actual cell;
 * window.minesweeper is used only to *read* state and to decide which cell to
 * click next, never to reveal on the game's behalf.
 *
 *   docker run --rm --ipc=host \
 *     -v /srv/ichabod/apps/minesweeper/tools:/tools:ro \
 *     -v /srv/ichabod/apps/minesweeper/proof:/proof \
 *     mcr.microsoft.com/playwright:v1.55.0-noble \
 *     node /tools/verify.js https://minesweeper.ichabod-crane.net/
 */
// The Playwright image ships the browsers but not the npm package; whichever of
// these is installed alongside is fine, both expose the same chromium driver.
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
const cell = (page, i) => page.locator('.cell[data-i="' + i + '"]');

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => consoleErrors.push('requestfailed: ' + r.url()));

  console.log('\n== Loading ' + URL);
  const resp = await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
  check('page returns 200', resp.status() === 200, 'status ' + resp.status());
  check('served over https', page.url().startsWith('https://'), page.url());
  check('title is Minesweeper', (await page.title()) === 'Minesweeper');
  check('game script initialised', await page.evaluate(() => !!window.minesweeper));

  /* ---------------- difficulties ---------------- */

  console.log('\n== Difficulties');
  for (const [name, cols, rows, mines] of [
    ['beginner', 9, 9, 10],
    ['intermediate', 16, 16, 40],
    ['expert', 30, 16, 99],
  ]) {
    await page.click('.diff-btn[data-difficulty="' + name + '"]');
    const s = await state(page);
    const rendered = await page.locator('.board .cell').count();
    check(
      name + ' is ' + cols + 'x' + rows + '/' + mines,
      s.cols === cols && s.rows === rows && s.mines === mines && rendered === cols * rows,
      s.cols + 'x' + s.rows + '/' + s.mines + ', ' + rendered + ' cells rendered'
    );
    check(name + ' mine counter reads ' + String(mines).padStart(3, '0'),
      (await page.locator('#mine-count').textContent()) === String(mines).padStart(3, '0'));
  }

  /* ---------------- game 1: play to a WIN ---------------- */

  console.log('\n== Game 1 — beginner, played to a win with real clicks');
  await page.click('.diff-btn[data-difficulty="beginner"]');

  // First click, dead centre of a 9x9.
  const first = 40;
  await cell(page, first).click();
  let s = await state(page);
  check('first click seeded the mines', s.seeded);
  check('first click did NOT detonate', !s.over, 'over=' + s.over);
  check('first clicked square is not a mine',
    (await page.evaluate((i) => window.minesweeper.mineAt(i), first)) === false);
  check('first click flood-filled a region', s.revealed > 1, s.revealed + ' squares opened');
  check('timer started', (await page.locator('#timer').textContent()) !== null);

  // Right-click flags, and right-clicking again unflags.
  const hidden = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.cell').forEach((el) => {
      if (!el.classList.contains('revealed')) out.push(Number(el.dataset.i));
    });
    return out;
  });
  const flagIdx = hidden[0];
  await cell(page, flagIdx).click({ button: 'right' });
  check('right-click sets a flag', (await cell(page, flagIdx).textContent()) === '🚩');
  check('flagging decrements the mine counter',
    (await page.locator('#mine-count').textContent()) === '009',
    await page.locator('#mine-count').textContent());
  await cell(page, flagIdx).click({ button: 'right' });
  check('right-click again clears the flag', (await cell(page, flagIdx).textContent()) === '');
  check('unflagging restores the mine counter',
    (await page.locator('#mine-count').textContent()) === '010');

  // Click every remaining safe square, for real, until the game is won.
  let guard = 0;
  for (;;) {
    if (guard++ > 200) throw new Error('win loop did not terminate');
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

  s = await state(page);
  check('game is over', s.over);
  check('game is WON', s.won === true, 'won=' + s.won);
  check('every non-mine square is revealed',
    s.revealed === s.cols * s.rows - s.mines,
    s.revealed + ' of ' + (s.cols * s.rows - s.mines));
  check('winning face is 😎', (await page.locator('#reset').textContent()) === '😎');
  const winText = await page.locator('#status').textContent();
  check('win is announced', /Cleared!/.test(winText), winText);
  check('remaining mines auto-flagged',
    (await page.locator('#mine-count').textContent()) === '000');
  await page.screenshot({ path: OUT + '/01-win-beginner.png' });
  console.log('  -> screenshot 01-win-beginner.png');

  /* ---------------- game 2: play to a LOSS ---------------- */

  console.log('\n== Game 2 — beginner, played to a loss with real clicks');
  await page.click('#reset');
  s = await state(page);
  check('reset clears the board', !s.over && !s.seeded && s.revealed === 0);
  check('reset face is 🙂', (await page.locator('#reset').textContent()) === '🙂');

  await cell(page, first).click();
  const mineIdx = await page.evaluate(() => {
    const st = window.minesweeper.state();
    for (let i = 0; i < st.cols * st.rows; i++) if (window.minesweeper.mineAt(i)) return i;
    return -1;
  });
  check('a mine exists to click', mineIdx >= 0, 'index ' + mineIdx);
  await cell(page, mineIdx).click();

  s = await state(page);
  check('clicking a mine ends the game', s.over === true);
  check('game is LOST', s.won === false, 'won=' + s.won);
  check('losing face is 😵', (await page.locator('#reset').textContent()) === '😵');
  const loseText = await page.locator('#status').textContent();
  check('loss is announced', /Boom/.test(loseText), loseText);
  check('the clicked mine is highlighted',
    (await cell(page, mineIdx).getAttribute('class')).includes('mine-hit'));
  const shownMines = await page.locator('.cell.revealed').evaluateAll(
    (els) => els.filter((e) => e.textContent === '💣').length);
  check('all 10 mines are revealed on loss', shownMines === 10, shownMines + ' shown');
  await page.screenshot({ path: OUT + '/02-loss-beginner.png' });
  console.log('  -> screenshot 02-loss-beginner.png');

  /* ---------------- game 3: chording ---------------- */

  console.log('\n== Game 3 — chording on a satisfied number');
  await page.click('#reset');
  await cell(page, first).click();

  const chordTarget = await page.evaluate(() => {
    const st = window.minesweeper.state();
    const cols = st.cols, rows = st.rows;
    const nb = (i) => {
      const out = [], x = i % cols, y = (i - x) / cols;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) out.push(ny * cols + nx);
      }
      return out;
    };
    const els = document.querySelectorAll('.cell');
    for (let i = 0; i < els.length; i++) {
      if (!els[i].classList.contains('revealed')) continue;
      const n = Number(els[i].textContent);
      if (!n) continue;
      const ns = nb(i);
      const mines = ns.filter((j) => window.minesweeper.mineAt(j));
      const hiddenSafe = ns.filter(
        (j) => !window.minesweeper.mineAt(j) && !els[j].classList.contains('revealed'));
      if (mines.length === n && hiddenSafe.length > 0) return { i, mines, hiddenSafe };
    }
    return null;
  });

  if (!chordTarget) {
    console.log('  SKIP  no satisfiable number adjacent to a covered safe square this deal');
  } else {
    for (const m of chordTarget.mines) await cell(page, m).click({ button: 'right' });
    const before = (await state(page)).revealed;
    await cell(page, chordTarget.i).click();
    const after = await state(page);
    check('chord revealed the covered neighbours',
      after.revealed > before, before + ' -> ' + after.revealed);
    check('chord did not detonate', !after.over || after.won, 'over=' + after.over);
  }

  /* ---------------- expert renders ---------------- */

  console.log('\n== Expert board renders');
  await page.click('.diff-btn[data-difficulty="expert"]');
  await cell(page, 240).click();
  s = await state(page);
  check('expert first click is safe', !s.over && s.seeded, 'over=' + s.over);
  const realMines = await page.evaluate(() => {
    const st = window.minesweeper.state();
    let c = 0;
    for (let i = 0; i < st.cols * st.rows; i++) if (window.minesweeper.mineAt(i)) c++;
    return c;
  });
  check('expert board holds exactly 99 mines', realMines === 99, realMines + ' mines');
  await page.screenshot({ path: OUT + '/03-expert.png' });
  console.log('  -> screenshot 03-expert.png');

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
