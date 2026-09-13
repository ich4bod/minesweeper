/*
 * Plays the live site to a win with the keyboard and nothing else, and proves
 * it was the keyboard by recording every mouse and pointer event the page sees
 * and asserting the list is empty at the end. A test that merely *avoided*
 * calling click() would prove nothing — Playwright's own focus(), hover() and
 * scrollIntoViewIfNeeded() all reach for the pointer, and any of them
 * creeping in would quietly turn this back into the mouse test that already
 * exists.
 *
 *   docker run --rm --ipc=host \
 *     -v /srv/ichabod/apps/minesweeper/tools:/tools:ro \
 *     -v /srv/ichabod/apps/minesweeper/.verify/node_modules:/node_modules:ro \
 *     -v /srv/ichabod/apps/minesweeper/proof:/proof \
 *     mcr.microsoft.com/playwright:v1.55.0-noble \
 *     node /tools/verify-keyboard.js https://minesweeper.ichabod-crane.net/
 *
 * The node_modules mount is not optional; tools/verify.js explains why.
 *
 * window.minesweeper is used only to *read* — which squares are covered and
 * which hold mines, so the walk has somewhere to aim. Every reveal, flag and
 * chord below goes through a real key event.
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

/* The focused square's index, or -1 when the caret is off the board. */
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a && a.classList && a.classList.contains('cell') ? Number(a.dataset.i) : -1;
});

/* How many squares are in the tab order. Exactly one is the whole point of a
   roving tabindex: on expert the other answer is 480. */
const tabStops = (page) =>
  page.evaluate(() => document.querySelectorAll('#board [tabindex="0"]').length);

const pointerEvents = (page) => page.evaluate(() => window.__pointer.slice());

/* Walks the caret with arrow keys. The presses are computed rather than
   steered one at a time — clamping makes the path deterministic — and the
   landing is checked by the caller. */
async function walk(page, cols, from, to) {
  const fx = from % cols, fy = (from - fx) / cols;
  const tx = to % cols, ty = (to - tx) / cols;
  for (let k = 0; k < Math.abs(tx - fx); k++) await page.keyboard.press(tx > fx ? 'ArrowRight' : 'ArrowLeft');
  for (let k = 0; k < Math.abs(ty - fy); k++) await page.keyboard.press(ty > fy ? 'ArrowDown' : 'ArrowUp');
  return to;
}

/* Tab until the caret is on something matching `sel`, and report how many
   presses it took. */
async function tabTo(page, sel, opts) {
  const back = opts && opts.back;
  for (let n = 1; n <= 24; n++) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    const hit = await page.evaluate(
      (s) => !!(document.activeElement && document.activeElement.matches(s)), sel);
    if (hit) return n;
  }
  return -1;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => consoleErrors.push('requestfailed: ' + r.url()));

  // Installed before any page script runs, in the capture phase, so nothing
  // can stop an event before it is counted.
  //
  // One allowance, and it stops at the edge of the board. Pressing Enter on a
  // focused <button> makes the browser synthesise a click on it — that is what
  // a button is *for*, and counting it would fail the run for doing the right
  // thing. A synthesised click carries detail === 0 and no coordinates; a real
  // press carries detail >= 1.
  //
  // Inside #board nothing is exempt. The squares are divs, so no key can
  // produce a click on one; anything at all landing there means the board was
  // driven by something other than the keys, which is the claim under test.
  await page.addInitScript(() => {
    window.__pointer = [];
    ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
     'pointerdown', 'pointerup', 'touchstart'].forEach((type) => {
      document.addEventListener(type, (e) => {
        const t = e.target;
        const onBoard = t && t.closest && t.closest('#board');
        if (!onBoard && type === 'click' && e.detail === 0) return;
        window.__pointer.push(type + ' on ' + ((t && t.className) || t.nodeName || '?'));
      }, true);
    });
  });

  console.log('\n== Loading ' + URL);
  const resp = await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
  check('page returns 200', resp.status() === 200, 'status ' + resp.status());
  check('game script initialised', await page.evaluate(() => !!window.minesweeper));

  let s = await state(page);
  const cols = s.cols, rows = s.rows, total = cols * rows;
  check('starting on beginner', cols === 9 && rows === 9, cols + 'x' + rows);

  /* ---------------- the board is a grid, and reachable ---------------- */

  console.log('\n== Reaching the board with Tab');

  const snap = await page.locator('#board').ariaSnapshot();
  check('gridcells sit inside rows inside the grid',
    /grid[^\n]*\n\s*- row/.test(snap), snap.split('\n').slice(0, 2).join(' / ').trim());
  check('a covered square announces itself', /gridcell "covered"/.test(snap));

  const presses = await tabTo(page, '.cell');
  check('Tab reaches the board', presses > 0, presses + ' presses from the top of the page');
  check('exactly one square is in the tab order', (await tabStops(page)) === 1,
    (await tabStops(page)) + ' of ' + total);
  check('the caret starts in the middle of the board', (await focused(page)) === 40,
    'square ' + (await focused(page)));
  check('the focused square draws a focus ring',
    await page.evaluate(() => document.activeElement.matches(':focus-visible')));

  // One more Tab must leave the board entirely. If the roving tabindex were
  // broken this walks into square 41 instead, and a player would need 81
  // presses to get past a beginner board.
  await page.keyboard.press('Tab');
  check('one more Tab leaves the board', (await focused(page)) === -1);
  await page.keyboard.press('Shift+Tab');
  check('Shift+Tab returns to the square we left', (await focused(page)) === 40);

  /* ---------------- moving ---------------- */

  console.log('\n== Arrow keys, Home/End, PageUp/PageDown');

  let at = 40;
  for (const [key, expect] of [
    ['ArrowRight', 41], ['ArrowDown', 50], ['ArrowLeft', 49], ['ArrowUp', 40],
  ]) {
    await page.keyboard.press(key);
    const got = await focused(page);
    check(key + ' moves to ' + expect, got === expect, 'square ' + got);
    at = got;
  }
  check('moving kept exactly one tab stop', (await tabStops(page)) === 1);

  await page.keyboard.press('Home');
  check('Home goes to the start of the row', (await focused(page)) === 36);
  await page.keyboard.press('End');
  check('End goes to the end of the row', (await focused(page)) === 44);
  await page.keyboard.press('PageUp');
  check('PageUp goes to the top of the column', (await focused(page)) === 8);
  await page.keyboard.press('PageDown');
  check('PageDown goes to the bottom of the column', (await focused(page)) === 80);
  await page.keyboard.press('Control+Home');
  check('Ctrl+Home goes to the first square', (await focused(page)) === 0);

  // Clamped, not wrapped: at the top-left corner both of these do nothing.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  check('the caret clamps at the top-left corner rather than wrapping',
    (await focused(page)) === 0, 'square ' + (await focused(page)));
  await page.keyboard.press('Control+End');
  check('Ctrl+End goes to the last square', (await focused(page)) === total - 1);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  check('the caret clamps at the bottom-right corner too',
    (await focused(page)) === total - 1, 'square ' + (await focused(page)));
  at = total - 1;

  /* ---------------- revealing and flagging ---------------- */

  console.log('\n== Enter reveals, F flags');

  at = await walk(page, cols, at, 40);
  check('arrow keys walked back to the centre', (await focused(page)) === 40);

  await page.keyboard.press('Enter');
  s = await state(page);
  check('Enter seeded the mines', s.seeded);
  check('Enter did not detonate the first square', !s.over, 'over=' + s.over);
  check('Enter flood-filled a region', s.revealed > 1, s.revealed + ' squares opened');
  check('the clock is running', (await page.evaluate(
    () => document.getElementById('timer').textContent)) !== null);
  check('the revealed square now announces its count',
    await page.evaluate(() => {
      const el = document.querySelector('.cell[data-i="40"]');
      return el.getAttribute('aria-label') === (el.textContent || 'empty');
    }));

  const covered = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.cell').forEach((el) => {
      if (!el.classList.contains('revealed')) out.push(Number(el.dataset.i));
    });
    return out;
  });
  at = await walk(page, cols, at, covered[0]);
  await page.keyboard.press('f');
  check('F plants a flag', await page.evaluate(
    (i) => document.querySelector('.cell[data-i="' + i + '"]').textContent === '🚩', covered[0]));
  check('the flag is announced', await page.evaluate(
    (i) => document.querySelector('.cell[data-i="' + i + '"]').getAttribute('aria-label') === 'flagged',
    covered[0]));
  check('flagging decremented the mine counter', (await page.evaluate(
    () => document.getElementById('mine-count').textContent)) === '009');
  await page.keyboard.press('F');
  check('F again clears the flag', await page.evaluate(
    (i) => document.querySelector('.cell[data-i="' + i + '"]').textContent === '', covered[0]));
  check('unflagging restored the mine counter', (await page.evaluate(
    () => document.getElementById('mine-count').textContent)) === '010');

  // The ring on a *covered* square, which is the harder of the two to see: a
  // raised grey square with no text on it, mid-game.
  await page.screenshot({ path: OUT + '/11-keyboard-focus.png' });
  console.log('  -> screenshot 11-keyboard-focus.png');

  /* ---------------- chording ---------------- */

  console.log('\n== Enter on a satisfied number chords');

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
      if (mines.length === n && hiddenSafe.length > 0) return { i, mines };
    }
    return null;
  });

  if (!chordTarget) {
    console.log('  SKIP  no satisfiable number next to a covered safe square this deal');
  } else {
    for (const m of chordTarget.mines) {
      at = await walk(page, cols, at, m);
      await page.keyboard.press('f');
    }
    at = await walk(page, cols, at, chordTarget.i);
    check('the caret is on the number to chord', (await focused(page)) === chordTarget.i);
    const before = (await state(page)).revealed;
    await page.keyboard.press('Enter');
    const after = await state(page);
    check('Enter on a satisfied number chorded',
      after.revealed > before, before + ' -> ' + after.revealed);
    check('the chord did not detonate', !after.over || after.won, 'over=' + after.over);
  }

  /* ---------------- play it out ---------------- */

  console.log('\n== Playing the rest of the board to a win, keyboard only');

  let moves = 0, strays = 0, guard = 0;
  for (;;) {
    if (guard++ > 200) throw new Error('win loop did not terminate');
    // Nearest covered safe square to the caret, so the walk stays short.
    const next = await page.evaluate((from) => {
      const st = window.minesweeper.state();
      if (st.over) return -1;
      const cols = st.cols;
      const fx = from % cols, fy = (from - fx) / cols;
      const els = document.querySelectorAll('.cell');
      let best = -1, bestD = Infinity;
      for (let i = 0; i < els.length; i++) {
        if (els[i].classList.contains('revealed')) continue;
        if (window.minesweeper.mineAt(i)) continue;
        const x = i % cols, y = (i - x) / cols;
        const d = Math.abs(x - fx) + Math.abs(y - fy);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }, at);
    if (next < 0) break;

    at = await walk(page, cols, at, next);
    if ((await focused(page)) !== next) strays++;
    // A flagged square ignores Enter, exactly as a click on one does; clear it
    // first. The chord above leaves real flags on the board.
    if (await page.evaluate((i) =>
      document.querySelector('.cell[data-i="' + i + '"]').classList.contains('flagged'), next)) {
      await page.keyboard.press('f');
    }
    await page.keyboard.press('Enter');
    moves++;
  }

  check('every arrow walk landed on the square it aimed at', strays === 0,
    moves + ' moves, ' + strays + ' astray');

  s = await state(page);
  check('the game is over', s.over);
  check('the game is WON, by keyboard alone', s.won === true, 'won=' + s.won);
  check('every non-mine square is revealed',
    s.revealed === total - s.mines, s.revealed + ' of ' + (total - s.mines));
  check('the winning face is 😎', (await page.evaluate(
    () => document.getElementById('reset').textContent)) === '😎');
  const winText = await page.evaluate(() => document.getElementById('status').textContent);
  check('the win is announced', /Cleared!/.test(winText), winText);

  let mouse = await pointerEvents(page);
  check('not one mouse or pointer event reached the page', mouse.length === 0,
    mouse.slice(0, 4).join(' | ') || 'none');

  await page.screenshot({ path: OUT + '/10-keyboard-win.png' });
  console.log('  -> screenshot 10-keyboard-win.png');

  /* ---------------- the rebuild ---------------- */

  // newGame() throws every cell away and builds new ones. This is the part
  // that was most likely to break: focus lands on a node that no longer
  // exists, the tab order empties out, and the board becomes unreachable
  // without ever looking broken.
  console.log('\n== Focus survives the board being rebuilt');

  const wasAt = await focused(page);
  await page.keyboard.press('r');
  s = await state(page);
  check('R started a new game', !s.over && !s.seeded && s.revealed === 0);
  check('the caret is still on the board after the rebuild',
    (await focused(page)) >= 0, 'square ' + (await focused(page)));
  check('and on the same square it was on', (await focused(page)) === wasAt,
    wasAt + ' -> ' + (await focused(page)));
  check('the rebuilt board has exactly one tab stop', (await tabStops(page)) === 1);
  check('the caret is still the ring-bearer',
    await page.evaluate(() => document.activeElement.matches(':focus-visible')));

  // Whichever way is not into a wall. The square the last game ended on is
  // wherever the board happened to leave it, and on a right-hand edge
  // ArrowRight correctly does nothing at all.
  const intoBoard = wasAt % cols === cols - 1 ? -1 : 1;
  await page.keyboard.press(intoBoard === 1 ? 'ArrowRight' : 'ArrowLeft');
  at = wasAt + intoBoard;
  check('arrow keys still move on the rebuilt board', (await focused(page)) === at,
    'square ' + (await focused(page)) + ', wanted ' + at);
  await page.keyboard.press('Enter');
  s = await state(page);
  check('Enter still reveals on the rebuilt board', s.seeded && s.revealed > 0,
    s.revealed + ' squares opened');

  /* ---------------- the resize ---------------- */

  console.log('\n== Changing difficulty from the keyboard');

  const back = await tabTo(page, '.diff-btn[data-difficulty="expert"]', { back: true });
  check('Shift+Tab reaches the Expert button', back > 0, back + ' presses back from the board');
  await page.keyboard.press('Enter');
  s = await state(page);
  check('Enter on Expert dealt an expert board', s.cols === 30 && s.rows === 16,
    s.cols + 'x' + s.rows);
  check('the expert board has exactly one tab stop', (await tabStops(page)) === 1);

  const fwd = await tabTo(page, '.cell');
  check('Tab reaches the expert board', fwd > 0, fwd + ' presses');
  check('the caret recentred rather than keeping a square that moved',
    (await focused(page)) === 8 * 30 + 15, 'square ' + (await focused(page)));
  await page.keyboard.press('ArrowDown');
  check('arrows move by a row of 30 on expert', (await focused(page)) === 8 * 30 + 15 + 30,
    'square ' + (await focused(page)));

  /* ---------------- and nothing touched a mouse ---------------- */

  console.log('\n== Nothing above used a pointer');

  mouse = await pointerEvents(page);
  check('still not one mouse or pointer event, start to finish', mouse.length === 0,
    mouse.slice(0, 6).join(' | ') || 'none');
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
