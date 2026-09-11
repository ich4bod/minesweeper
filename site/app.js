/* Minesweeper — classic rules, no dependencies. */
(function () {
  'use strict';

  var DIFFICULTIES = {
    beginner:     { cols: 9,  rows: 9,  mines: 10 },
    intermediate: { cols: 16, rows: 16, mines: 40 },
    expert:       { cols: 30, rows: 16, mines: 99 }
  };

  var boardEl  = document.getElementById('board');
  var mineEl   = document.getElementById('mine-count');
  var timerEl  = document.getElementById('timer');
  var faceEl   = document.getElementById('reset');
  var statusEl = document.getElementById('status');
  var bestEl   = document.getElementById('best-time');
  var diffBtns = Array.prototype.slice.call(document.querySelectorAll('.diff-btn'));

  var cols, rows, total, mineCount;
  var board;            // [{ mine, adj, state }]  state: 'hidden' | 'revealed' | 'flagged'
  var cells;            // parallel array of DOM nodes
  var seeded;           // mines placed yet?
  var over, won;
  var flags, revealed;
  var startTime, timerId;
  var difficulty = 'beginner';

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

  /* ---------- setup ---------- */

  function newGame(which) {
    if (which) difficulty = which;
    var cfg = DIFFICULTIES[difficulty];
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

    renderBest();
    buildGrid();
    faceEl.textContent = '🙂';
    setStatus('Left-click to reveal. Right-click to flag.', '');
    updateMineCount();
  }

  function buildGrid() {
    boardEl.classList.remove('over');
    boardEl.style.gridTemplateColumns = 'repeat(' + cols + ', var(--cell))';
    var frag = document.createDocumentFragment();
    cells = new Array(total);
    for (var i = 0; i < total; i++) {
      var d = document.createElement('div');
      d.className = 'cell';
      d.setAttribute('role', 'gridcell');
      d.dataset.i = String(i);
      cells[i] = d;
      frag.appendChild(d);
    }
    boardEl.textContent = '';
    boardEl.appendChild(frag);
  }

  function placeMines(safeIdx) {
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
      var r = k + Math.floor(Math.random() * (pool.length - k));
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

    if (cell.state === 'revealed') {
      cls += ' revealed';
      if (cell.mine) {
        text = '💣';
        if (cell.hit) cls += ' mine-hit';
      } else if (cell.adj > 0) {
        text = String(cell.adj);
        cls += ' n' + cell.adj;
      }
    } else if (cell.state === 'flagged') {
      cls += ' flagged';
      text = cell.wrong ? '❌' : '🚩';
      if (cell.wrong) cls += ' mine-wrong';
    }

    el.className = cls;
    if (el.textContent !== text) el.textContent = text;
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

    if (!seeded) {
      placeMines(idx);
      startTimer();
    }

    if (cell.mine) {
      cell.state = 'revealed';
      cell.hit = true;
      lose();
      return;
    }

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

  faceEl.addEventListener('click', function () { newGame(); });

  diffBtns.forEach(function (b) {
    b.addEventListener('click', function () { newGame(b.dataset.difficulty); });
  });

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
        bestShown: bestEl.textContent
      };
    },
    mineAt: function (i) { return board[i].mine; },
    bests: readBests
  };

  newGame('beginner');
})();
