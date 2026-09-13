/* Minesweeper — classic rules, no dependencies. */
(function () {
  'use strict';

  var DIFFICULTIES = {
    beginner:     { cols: 9,  rows: 9,  mines: 10 },
    intermediate: { cols: 16, rows: 16, mines: 40 },
    expert:       { cols: 30, rows: 16, mines: 99 }
  };

  var boardEl   = document.getElementById('board');
  var mineEl    = document.getElementById('mine-count');
  var timerEl   = document.getElementById('timer');
  var faceEl    = document.getElementById('reset');
  var statusEl  = document.getElementById('status');
  var bestEl    = document.getElementById('best-time');
  var bestLabel = document.getElementById('best-label');
  var dailyEl   = document.getElementById('daily-line');
  var dailyDateEl = document.getElementById('daily-date');
  var shareEl   = document.getElementById('share');
  var shareTextEl = document.getElementById('share-text');
  var shareCopyEl = document.getElementById('share-copy');
  var diffBtns = Array.prototype.slice.call(document.querySelectorAll('.diff-btn'));
  var modeBtns = Array.prototype.slice.call(document.querySelectorAll('.mode-btn'));

  var cols, rows, total, mineCount;
  var board;            // [{ mine, adj, state }]  state: 'hidden' | 'revealed' | 'flagged'
  var cells;            // parallel array of DOM nodes
  var seeded;           // mines placed yet?
  var over, won;
  var flags, revealed;
  var startTime, timerId;
  var difficulty = 'beginner';
  var mode = 'random';  // 'random' | 'daily'
  var dailyDate;        // 'YYYY-MM-DD', UTC
  var dailyAnchor = -1; // the opening square a daily deal hands everyone
  var focusIdx = -1;    // the one cell holding tabindex="0"; -1 means "recentre"

  /* ---------- helpers ---------- */

  function pad(n) {
    n = Math.max(0, Math.min(999, n));
    return String(n).padStart(3, '0');
  }

  function neighbors(i) {
    var out = [];
    var x = i % cols;
    var y = (i - x) / cols;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        var nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        out.push(ny * cols + nx);
      }
    }
    return out;
  }

  /* ---------- best times ---------- */

  // Best time per difficulty, in whole seconds, kept in localStorage under one
  // versioned key. Storage is not guaranteed to be there: Safari's private mode
  // and a user who has turned site data off both *throw* on access rather than
  // returning null, so every touch is guarded. A browser without storage plays
  // the game normally and simply never keeps a record.
  var BEST_KEY = 'minesweeper.best.v1';

  function readBests() {
    try {
      var parsed = JSON.parse(window.localStorage.getItem(BEST_KEY));
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function bestFor(which) {
    var v = readBests()[which];
    return (typeof v === 'number' && isFinite(v) && v >= 0) ? Math.floor(v) : null;
  }

  function clock(secs) {
    return Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
  }

  function renderBest() {
    if (mode === 'daily') {
      var d = dailyResult();
      bestEl.textContent = d ? clock(d.secs) : '—';
      return;
    }
    var b = bestFor(difficulty);
    bestEl.textContent = b === null ? '—' : clock(b);
  }

  // Only a win gets here, and only a strictly faster one is written.
  // Returns true when this run set the record, so the win message can say so.
  function recordBest(secs) {
    var prev = bestFor(difficulty);
    if (prev !== null && secs >= prev) return false;
    var bests = readBests();
    bests[difficulty] = secs;
    try {
      window.localStorage.setItem(BEST_KEY, JSON.stringify(bests));
    } catch (e) {
      return false;
    }
    renderBest();
    return true;
  }

  /* ---------- daily boards ---------- */

  // A Daily board is the same board for everyone who plays that UTC date, which
  // is the whole point: a time is only worth comparing if the minefield was.
  // That needs a *reproducible* source of randomness, so the deal runs off a
  // seeded PRNG rather than Math.random(), and the seed is derived from nothing
  // but the date, the difficulty and a version tag. No server, no stored board
  // — two browsers that agree on today's date agree on today's minefield.
  //
  // Bumping SEED_VERSION re-deals every past date, so it changes only if the
  // generator itself has to change.
  var SEED_VERSION = 'v1';

  // FNV-1a, for turning the seed string into the 32 bits mulberry32 wants.
  function hashSeed(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // mulberry32: 32 bits of state, no dependencies, and — the only property that
  // matters here — identical output for identical input in every engine, which
  // Math.random() explicitly does not promise.
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function utcToday() {
    return new Date().toISOString().slice(0, 10);
  }

  // Strict YYYY-MM-DD, on the real calendar. The shape test and Date.parse are
  // both necessary and together still not enough: Date.parse does not reject
  // 2026-02-31, it rolls it forward to 3 March. Round-tripping the parsed date
  // back to a string is what actually catches a day that does not exist.
  function validDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var t = Date.parse(s + 'T00:00:00Z');
    if (isNaN(t)) return false;
    return new Date(t).toISOString().slice(0, 10) === s;
  }

  function seedFor(date, which) {
    return 'minesweeper|' + SEED_VERSION + '|' + date + '|' + which;
  }

  /*
   * Deals the whole board up front from the seeded stream and returns the
   * opening square.
   *
   * Random mode places mines *after* the first click so it can spare the
   * clicked square — which means the layout depends on where you clicked, and
   * two players would get different minefields from the same seed. A shared
   * board cannot work that way. So Daily picks the opening square from the
   * seed too, excludes it and its eight neighbours from the mine pool, and
   * opens it for you. Everyone starts from the identical opened position, the
   * first click is still always safe, and the layout does not depend on any
   * choice the player makes.
   */
  function dealDaily() {
    var rng = mulberry32(hashSeed(seedFor(dailyDate, difficulty)));
    var anchor = Math.floor(rng() * total);
    placeMines(anchor, rng);
    return anchor;
  }

  /* ---------- daily results ---------- */

  // Kept apart from the best-time record on purpose: a Daily time is a time on
  // one specific board and has no business competing with a lifetime best on
  // random deals. Same storage caveats as readBests() — every touch is guarded.
  var DAILY_KEY = 'minesweeper.daily.v1';
  var DAILY_KEEP = 60;

  function readDailies() {
    try {
      var parsed = JSON.parse(window.localStorage.getItem(DAILY_KEY));
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function dailyKey() {
    return dailyDate + '|' + difficulty;
  }

  function dailyResult() {
    var r = readDailies()[dailyKey()];
    return (r && typeof r.secs === 'number' && isFinite(r.secs)) ? r : null;
  }

  // Wins only, fastest kept. A loss leaves no trace, so a bad opening guess
  // does not brand the day as failed.
  function recordDaily(secs) {
    var all = readDailies();
    var prev = all[dailyKey()];
    if (prev && typeof prev.secs === 'number' && secs >= prev.secs) return false;
    all[dailyKey()] = { secs: secs, won: true };

    // The keys sort chronologically, so dropping the lexicographic tail drops
    // the oldest dates. This is a scoreboard, not an archive.
    var keys = Object.keys(all).sort();
    while (keys.length > DAILY_KEEP) delete all[keys.shift()];

    try {
      window.localStorage.setItem(DAILY_KEY, JSON.stringify(all));
    } catch (e) {
      return false;
    }
    return true;
  }

  /* ---------- daily chrome ---------- */

  function shareLine(secs) {
    var where = window.location.origin + window.location.pathname;
    return 'Minesweeper Daily ' + dailyDate + ' · ' + difficulty + ' · ' + secs + 's\n' +
           where + '?d=' + dailyDate + '&level=' + difficulty;
  }

  function showShare(secs) {
    shareTextEl.textContent = shareLine(secs);
    shareEl.hidden = false;
    shareCopyEl.textContent = 'Copy';
  }

  function hideShare() {
    shareEl.hidden = true;
    shareTextEl.textContent = '';
  }

  function renderMode() {
    modeBtns.forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    });
    var isDaily = mode === 'daily';
    dailyEl.hidden = !isDaily;
    if (isDaily) dailyDateEl.textContent = dailyDate;
    bestLabel.textContent = isDaily ? 'Today' : 'Best';
  }

  // Daily mode is addressable rather than remembered. Keeping it out of
  // localStorage means a shared link is the only thing that puts you on a
  // shared board, and a plain visit is never silently on yesterday's puzzle.
  function readUrl() {
    var q;
    try {
      q = new URLSearchParams(window.location.search);
    } catch (e) {
      q = null;
    }
    var d = q && q.get('d');
    var m = q && q.get('mode');
    var level = q && q.get('level');

    dailyDate = validDate(d) ? d : utcToday();
    if (validDate(d) || m === 'daily') mode = 'daily';
    if (level && DIFFICULTIES[level]) difficulty = level;
  }

  function pushUrl() {
    if (!window.history || !window.history.replaceState) return;
    var url = window.location.pathname;
    if (mode === 'daily') url += '?d=' + dailyDate + '&level=' + difficulty;
    try {
      window.history.replaceState(null, '', url);
    } catch (e) {
      /* file:// and friends throw here; the game does not depend on it. */
    }
  }

  /* ---------- setup ---------- */

  function newGame(which) {
    if (which) difficulty = which;
    var cfg = DIFFICULTIES[difficulty];

    // A new game on the same difficulty leaves the caret where the player left
    // it; a *resize* recentres it, because square 400 on expert and square 400
    // on beginner are not the same place and one of them does not exist.
    if (cols !== cfg.cols || rows !== cfg.rows) focusIdx = -1;

    cols = cfg.cols; rows = cfg.rows; mineCount = cfg.mines;
    total = cols * rows;

    board = new Array(total);
    for (var i = 0; i < total; i++) board[i] = { mine: false, adj: 0, state: 'hidden' };

    seeded = false;
    over = false;
    won = false;
    flags = 0;
    revealed = 0;

    stopTimer();
    startTime = null;
    timerEl.textContent = pad(0);

    diffBtns.forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.difficulty === difficulty));
    });

    renderMode();
    renderBest();
    buildGrid();
    hideShare();
    faceEl.textContent = '🙂';
    updateMineCount();

    if (mode === 'daily') {
      dailyAnchor = dealDaily();
      // Opened directly rather than through reveal(), so the clock does not
      // start on a move the player did not make.
      floodFrom(dailyAnchor);
      setStatus('Daily board for ' + dailyDate + '. Everyone gets this one.', '');
    } else {
      dailyAnchor = -1;
      setStatus('Left-click to reveal. Right-click to flag. Or Tab to the board and use the arrow keys.', '');
    }
  }

  function buildGrid() {
    boardEl.classList.remove('over');
    boardEl.style.gridTemplateColumns = 'repeat(' + cols + ', var(--cell))';

    // Asked *before* the old cells are thrown away. newGame() rebuilds the
    // whole board, and a rebuild that ignored this would drop focus to <body>
    // — which for a player without a mouse is the game quietly ending.
    var hadFocus = boardEl.contains(document.activeElement);

    var frag = document.createDocumentFragment();
    cells = new Array(total);
    for (var y = 0; y < rows; y++) {
      // A role="grid" whose gridcells are not wrapped in a role="row" is
      // malformed, and a screen reader reading one announces no coordinates at
      // all. The row is `display: contents`, so it carries the role without
      // joining the layout — the cells stay direct grid items of .board and
      // every existing rule about them still applies.
      var row = document.createElement('div');
      row.className = 'row';
      row.setAttribute('role', 'row');
      for (var x = 0; x < cols; x++) {
        var i = y * cols + x;
        var d = document.createElement('div');
        d.className = 'cell';
        d.setAttribute('role', 'gridcell');
        // Covered squares carry no text, so without a label a screen reader
        // walks the board in silence. paint() keeps this in step afterwards.
        d.setAttribute('aria-label', 'covered');
        d.tabIndex = -1;
        d.dataset.i = String(i);
        cells[i] = d;
        row.appendChild(d);
      }
      frag.appendChild(row);
    }
    boardEl.textContent = '';
    boardEl.appendChild(frag);

    // Roving tabindex: exactly one cell is ever in the tab order, so Tab
    // reaches the board in one press and leaves it in one more, rather than
    // walking a player through 480 stops on expert.
    if (!(focusIdx >= 0 && focusIdx < total)) focusIdx = centreIdx();
    cells[focusIdx].tabIndex = 0;
    if (hadFocus) cells[focusIdx].focus();
  }

  // Where the caret starts, and where it returns after the board resizes. The
  // centre rather than the corner: on a fresh board Tab then Enter is then the
  // opening move a mouse player would have made anyway.
  function centreIdx() {
    return Math.floor(rows / 2) * cols + Math.floor(cols / 2);
  }

  // Moves the single tab stop, and the caret with it. The two must not drift:
  // a tabindex="0" left behind on a cell the player has walked away from puts
  // a second stop in the tab order.
  function moveFocus(i) {
    if (i < 0 || i >= total) return;
    if (cells[focusIdx]) cells[focusIdx].tabIndex = -1;
    focusIdx = i;
    cells[i].tabIndex = 0;
    cells[i].focus();
  }

  // `rand` is the source of randomness, defaulting to Math.random. Daily mode
  // passes a seeded stream instead; nothing else about the deal differs.
  function placeMines(safeIdx, rand) {
    rand = rand || Math.random;
    var exclude = {};
    exclude[safeIdx] = true;
    neighbors(safeIdx).forEach(function (n) { exclude[n] = true; });

    var pool = [];
    for (var i = 0; i < total; i++) if (!exclude[i]) pool.push(i);

    // Degenerate boards (too many mines to spare a whole 3x3) fall back to
    // sparing only the clicked square, which still honours "first click is safe".
    if (pool.length < mineCount) {
      pool = [];
      for (var j = 0; j < total; j++) if (j !== safeIdx) pool.push(j);
    }

    for (var k = 0; k < mineCount; k++) {
      var r = k + Math.floor(rand() * (pool.length - k));
      var t = pool[k]; pool[k] = pool[r]; pool[r] = t;
      board[pool[k]].mine = true;
    }

    for (var m = 0; m < total; m++) {
      if (board[m].mine) continue;
      var c = 0;
      neighbors(m).forEach(function (n) { if (board[n].mine) c++; });
      board[m].adj = c;
    }

    seeded = true;
  }

  /* ---------- rendering ---------- */

  function paint(i) {
    var cell = board[i];
    var el = cells[i];
    var cls = 'cell';
    var text = '';
    var label = 'covered';

    if (cell.state === 'revealed') {
      cls += ' revealed';
      if (cell.mine) {
        text = '💣';
        label = 'mine';
        if (cell.hit) cls += ' mine-hit';
      } else if (cell.adj > 0) {
        text = String(cell.adj);
        label = String(cell.adj);
        cls += ' n' + cell.adj;
      } else {
        label = 'empty';
      }
    } else if (cell.state === 'flagged') {
      cls += ' flagged';
      text = cell.wrong ? '❌' : '🚩';
      label = cell.wrong ? 'wrong flag' : 'flagged';
      if (cell.wrong) cls += ' mine-wrong';
    }

    el.className = cls;
    if (el.textContent !== text) el.textContent = text;
    // The emoji is decoration; this is what actually gets announced. A covered
    // square is an empty div and would otherwise be skipped over in silence.
    if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
  }

  function paintAll() {
    for (var i = 0; i < total; i++) paint(i);
  }

  function updateMineCount() {
    mineEl.textContent = pad(mineCount - flags);
  }

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  /* ---------- timer ---------- */

  function startTimer() {
    startTime = Date.now();
    timerId = setInterval(function () {
      timerEl.textContent = pad(Math.floor((Date.now() - startTime) / 1000));
    }, 250);
  }

  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  function elapsed() {
    return startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
  }

  /* ---------- gameplay ---------- */

  function reveal(idx) {
    if (over) return;
    var cell = board[idx];
    if (cell.state !== 'hidden') return;

    if (!seeded) placeMines(idx);
    // The clock starts on the player's first move. In random mode that is the
    // same moment the mines are placed; in daily mode the mines were already
    // dealt and a region already opened, so the two have to be separate.
    if (!startTime) startTimer();

    if (cell.mine) {
      cell.state = 'revealed';
      cell.hit = true;
      lose();
      return;
    }

    floodFrom(idx);
  }

  // Reveals idx and, if it is blank, everything its blank region touches.
  // Timer-free and mine-free: callers own both.
  function floodFrom(idx) {
    var stack = [idx];
    while (stack.length) {
      var i = stack.pop();
      var c = board[i];
      if (c.state !== 'hidden') continue;
      c.state = 'revealed';
      revealed++;
      paint(i);
      if (c.adj === 0) {
        neighbors(i).forEach(function (n) {
          if (board[n].state === 'hidden') stack.push(n);
        });
      }
    }

    if (revealed === total - mineCount) win();
  }

  function toggleFlag(idx) {
    if (over) return;
    var cell = board[idx];
    if (cell.state === 'revealed') return;
    if (cell.state === 'flagged') {
      cell.state = 'hidden';
      flags--;
    } else {
      cell.state = 'flagged';
      flags++;
    }
    paint(idx);
    updateMineCount();
  }

  // Left-click on a satisfied number clears its unflagged neighbours.
  function chord(idx) {
    if (over) return;
    var cell = board[idx];
    if (cell.state !== 'revealed' || cell.adj === 0) return;

    var ns = neighbors(idx);
    var flagged = 0;
    ns.forEach(function (n) { if (board[n].state === 'flagged') flagged++; });
    if (flagged !== cell.adj) return;

    ns.forEach(function (n) {
      if (board[n].state === 'hidden') reveal(n);
    });
  }

  function lose() {
    over = true;
    stopTimer();
    for (var i = 0; i < total; i++) {
      var c = board[i];
      if (c.mine && c.state === 'hidden') c.state = 'revealed';
      else if (!c.mine && c.state === 'flagged') c.wrong = true;
    }
    paintAll();
    boardEl.classList.add('over');
    faceEl.textContent = '😵';
    setStatus('Boom. You hit a mine — press the face to try again.', 'lose');
  }

  function win() {
    over = true;
    won = true;
    stopTimer();
    for (var i = 0; i < total; i++) {
      if (board[i].mine && board[i].state !== 'flagged') {
        board[i].state = 'flagged';
        flags++;
      }
    }
    paintAll();
    updateMineCount();
    boardEl.classList.add('over');
    faceEl.textContent = '😎';
    var secs = elapsed();

    if (mode === 'daily') {
      var faster = recordDaily(secs);
      renderBest();
      showShare(secs);
      setStatus('Cleared! ' + mineCount + ' mines in ' + secs + ' seconds — ' +
                'the ' + dailyDate + ' daily.' + (faster ? ' Your fastest run of it.' : ''), 'win');
      return;
    }

    var improved = recordBest(secs);
    setStatus('Cleared! ' + mineCount + ' mines in ' + secs + ' seconds.' +
              (improved ? ' A new best.' : ''), 'win');
  }

  /* ---------- input ---------- */

  function indexFrom(target) {
    var el = target.closest ? target.closest('.cell') : null;
    return el ? Number(el.dataset.i) : -1;
  }

  boardEl.addEventListener('click', function (e) {
    if (suppressClick) { suppressClick = false; return; }
    var i = indexFrom(e.target);
    if (i < 0) return;
    if (board[i].state === 'revealed') chord(i);
    else reveal(i);
  });

  boardEl.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var i = indexFrom(e.target);
    if (i < 0) return;
    toggleFlag(i);
  });

  boardEl.addEventListener('auxclick', function (e) {
    if (e.button !== 1) return;
    e.preventDefault();
    var i = indexFrom(e.target);
    if (i >= 0) chord(i);
  });

  // Long-press flags on touch devices.
  var pressTimer = null, suppressClick = false;

  boardEl.addEventListener('touchstart', function (e) {
    var i = indexFrom(e.target);
    if (i < 0) return;
    pressTimer = setTimeout(function () {
      pressTimer = null;
      suppressClick = true;
      toggleFlag(i);
      if (navigator.vibrate) navigator.vibrate(15);
    }, 400);
  }, { passive: true });

  function cancelPress() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  }
  boardEl.addEventListener('touchend', cancelPress);
  boardEl.addEventListener('touchmove', cancelPress, { passive: true });
  boardEl.addEventListener('touchcancel', cancelPress);

  /* ---------- keyboard ---------- */

  // The board is one tab stop with a roving tabindex inside it, so everything
  // below is bound to the board rather than the document: `f` flags only when
  // the caret is actually on a square, and typing it anywhere else does
  // nothing. Clicking a cell focuses it too, which is what keeps the caret
  // under the pointer for a player using both.
  boardEl.addEventListener('focusin', function (e) {
    var i = indexFrom(e.target);
    if (i >= 0 && i !== focusIdx) moveFocus(i);
  });

  var ARROWS = {
    ArrowLeft:  [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp:    [0, -1],
    ArrowDown:  [0, 1]
  };

  boardEl.addEventListener('keydown', function (e) {
    var i = indexFrom(e.target);
    if (i < 0) return;
    if (e.altKey || e.metaKey) return;

    var x = i % cols;
    var y = (i - x) / cols;
    var d = ARROWS[e.key];

    // Clamped at the edges rather than wrapped. Holding an arrow to get to the
    // far wall should stop at the wall — a caret that reappears on the
    // opposite side of a minefield loses the player their place.
    if (d) {
      e.preventDefault();
      moveFocus(Math.min(rows - 1, Math.max(0, y + d[1])) * cols +
                Math.min(cols - 1, Math.max(0, x + d[0])));
      return;
    }

    switch (e.key) {
      case 'Home':
        e.preventDefault();
        moveFocus(e.ctrlKey ? 0 : y * cols);
        return;
      case 'End':
        e.preventDefault();
        moveFocus(e.ctrlKey ? total - 1 : y * cols + cols - 1);
        return;
      case 'PageUp':
        e.preventDefault();
        moveFocus(x);
        return;
      case 'PageDown':
        e.preventDefault();
        moveFocus((rows - 1) * cols + x);
        return;
      case 'Enter':
      case ' ':
        // Deliberately the same branch the click handler takes, so the mouse
        // and the keyboard cannot drift apart: a revealed number chords,
        // anything else reveals.
        e.preventDefault();
        if (board[i].state === 'revealed') chord(i);
        else reveal(i);
        return;
      case 'f':
      case 'F':
        e.preventDefault();
        toggleFlag(i);
        return;
    }
  });

  faceEl.addEventListener('click', function () { newGame(); });

  diffBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      newGame(b.dataset.difficulty);
      pushUrl();
    });
  });

  modeBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      mode = b.dataset.mode === 'daily' ? 'daily' : 'random';
      // Leaving a past daily by way of Random and coming back should land on
      // today, not on the date the link arrived with.
      if (mode === 'daily') dailyDate = validDate(dailyDate) ? dailyDate : utcToday();
      newGame();
      pushUrl();
    });
  });

  shareCopyEl.addEventListener('click', function () {
    var text = shareTextEl.textContent;
    // Clipboard access is permissioned and absent on http://, so the button
    // reports what happened rather than assuming. The text is on screen and
    // selectable either way.
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      shareCopyEl.textContent = 'Select it';
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      shareCopyEl.textContent = 'Copied';
    }, function () {
      shareCopyEl.textContent = 'Select it';
    });
  });

  // New game from anywhere on the page. The board's own keys are bound to the
  // board, not here, precisely so they cannot fire while the caret is off it.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'r' || e.key === 'R') newGame();
  });

  /* Exposed so a game can be driven and inspected without clicking. */
  window.minesweeper = {
    newGame: newGame,
    reveal: reveal,
    toggleFlag: toggleFlag,
    chord: chord,
    state: function () {
      return {
        difficulty: difficulty,
        cols: cols, rows: rows, mines: mineCount,
        seeded: seeded, over: over, won: won,
        flags: flags, revealed: revealed,
        remaining: total - mineCount - revealed,
        best: bestFor(difficulty),
        bestShown: bestEl.textContent,
        mode: mode,
        date: dailyDate,
        anchor: dailyAnchor,
        seed: mode === 'daily' ? seedFor(dailyDate, difficulty) : null,
        daily: dailyResult()
      };
    },
    mineAt: function (i) { return board[i].mine; },
    // The whole minefield as one comparable string — '1' mine, '0' not. Two
    // deals are the same deal exactly when these match.
    layout: function () {
      var out = '';
      for (var i = 0; i < total; i++) out += board[i].mine ? '1' : '0';
      return out;
    },
    shareText: function () { return shareEl.hidden ? null : shareTextEl.textContent; },
    // Drives the date without waiting for tomorrow.
    setDailyDate: function (d) {
      if (!validDate(d)) return false;
      dailyDate = d;
      mode = 'daily';
      newGame();
      return true;
    },
    bests: readBests,
    dailies: readDailies
  };

  readUrl();
  newGame(difficulty);
})();
