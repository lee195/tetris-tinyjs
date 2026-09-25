/**
 * Bench mode: verify a change without a human at the keyboard.
 *
 * Phase 0 established the habit of measuring rather than assuming, but its
 * harness (`bench.html`) has to be self-contained — `TINYJS_HTML` materialises a
 * page into a temp dir, so it cannot import the game's modules. That left no way
 * to check the *real* renderer. This module closes that gap: it runs inside the
 * actual app, draws known states, and reads the pixels back.
 *
 * Two things it checks, both of which would otherwise need eyes:
 *
 *  1. **Render correctness, by pixel readback.** Layout mapping, the
 *     hidden-buffer clip, palette indexing, and the ghost. A renderer that
 *     forgot to subtract `VISIBLE_TOP` draws a plausible-looking board in the
 *     wrong place; only a pixel assertion catches that.
 *  2. **Frame pacing under load**, which is the plan's stated bar: p99 interval
 *     under 16.7 ms and zero dropped frames during a scripted DAS/ARR burst.
 *
 * Triggered by `TETRIS_BENCH=1`, reported through the `log` bridge method, then
 * the app quits. Run it with:
 *
 *   TETRIS_BENCH=1 TINYJS_DEBUG=1 timeout 60 tinyjs dev
 *
 * Not part of the shipping experience — nothing calls it unless the environment
 * asks for it.
 */

import { COLS, TOTAL_ROWS, VISIBLE_TOP, PIECE } from './constants.js';
import { setCell } from './board.js';
import { SHAPES } from './pieces.js';
import { makeGame, step, ghostRow, STATUS } from './game.js';
import { makeHandling, makeInputFrame } from './handling.js';
import { stepWithInput } from './apply.js';
import { makeLoop, advance } from './loop.js';
import { draw, boardCellX, boardCellY, BASE } from './render.js';
import { makePerf, recordFrame, stats, resetPerf, meetsBudget } from './perf.js';

const WELL_BG = [0x11, 0x14, 0x19];
const PAGE_BG = [0x0b, 0x0d, 0x11];

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function near(a, b, tol) {
  const t = tol === undefined ? 8 : tol;
  return Math.abs(a[0] - b[0]) <= t && Math.abs(a[1] - b[1]) <= t && Math.abs(a[2] - b[2]) <= t;
}

function show(c) {
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Sample one point, given in CSS pixels, from a full-canvas readback. */
function at(img, cssX, cssY, dpr) {
  // A dpr of 0 would map every coordinate to pixel (0,0) — which happens to be
  // the page background, so every check would "pass" against the wrong pixel.
  // Fail loudly instead of sampling the same corner forever.
  if (!(dpr > 0)) throw new Error('selftest: dpr is ' + dpr + ', read it after draw()');
  const px = Math.min(img.width - 1, Math.max(0, Math.round(cssX * dpr)));
  const py = Math.min(img.height - 1, Math.max(0, Math.round(cssY * dpr)));
  const i = (py * img.width + px) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** Centre of a board cell, in CSS pixels. */
function cellCentre(L, x, y) {
  const h = L.cell / 2;
  return [boardCellX(L, x) + h, boardCellY(L, y) + h];
}

/* ------------------------------------------------------------ render checks */

function checkRender(deps, report) {
  const { canvas, renderer } = deps;
  const ctx = renderer.ctx;

  // A known scene: two placed blocks of different colours, a fixed active piece
  // high up so its ghost lands far below it, and one block in the hidden buffer.
  const g = makeGame({ seed: 20240925 });
  step(g);
  g.board.rows.fill(0);
  g.board.colors.fill(0);
  g.board.top.fill(TOTAL_ROWS);
  setCell(g.board, 0, VISIBLE_TOP, 3);                 // top-left visible cell
  setCell(g.board, COLS - 1, TOTAL_ROWS - 1, 7);       // bottom-right
  setCell(g.board, 2, VISIBLE_TOP - 3, 1);             // hidden buffer — must not draw
  g.piece = PIECE.T;                                   // rot 0: (1,0),(0,1),(1,1),(2,1)
  g.rot = 0;
  g.x = 3;
  g.y = VISIBLE_TOP + 4;
  g.status = STATUS.FALLING;

  draw(renderer, g, { paused: false, over: false });

  // Read the layout and dpr AFTER the draw: syncSize() runs inside draw() and
  // is what establishes both, so reading them earlier gives dpr 0 and the
  // viewport's pre-layout size.
  const L = renderer.layout;
  const dpr = renderer.dpr;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const c = (x, y) => {
    const p = cellCentre(L, x, y);
    return at(img, p[0], p[1], dpr);
  };

  report('layout: cell ' + L.cell + 'px, well ' + L.boardW + 'x' + L.boardH +
    ' at (' + L.boardX + ',' + L.boardY + '), panel ' + L.panelW +
    'px at x=' + L.panelX + ', canvas ' + canvas.width + 'x' + canvas.height +
    ', dpr ' + dpr);

  // 1. A placed block lands in the cell it belongs to, in the right colour.
  const tl = c(0, VISIBLE_TOP);
  report.check('placed block at (0, VISIBLE_TOP) is the O colour',
    near(tl, rgb(BASE[3])), show(tl) + ' vs ' + BASE[3]);

  // 2. Palette indexing: a different colour index must give a different colour.
  const br = c(COLS - 1, TOTAL_ROWS - 1);
  report.check('placed block at (COLS-1, last row) is the Z colour',
    near(br, rgb(BASE[7])), show(br) + ' vs ' + BASE[7]);

  // 3. An empty cell is the well background.
  const empty = c(5, VISIBLE_TOP);
  report.check('an empty cell is the well background',
    near(empty, WELL_BG), show(empty));

  // 4. The active piece draws in its own colour, at its own position.
  const piece = c(4, VISIBLE_TOP + 4);
  report.check('the active T piece draws at (4, VISIBLE_TOP+4)',
    near(piece, rgb(BASE[PIECE.T + 1])), show(piece) + ' vs ' + BASE[PIECE.T + 1]);

  // 5. The hidden buffer is clipped. A block three rows above the well must not
  //    appear above the well's top edge.
  const aboveWell = at(img, cellCentre(L, 2, VISIBLE_TOP)[0],
    boardCellY(L, VISIBLE_TOP) - L.cell / 2, dpr);
  report.check('a block in the hidden buffer is not drawn',
    near(aboveWell, PAGE_BG), show(aboveWell));

  // 6. The well's own edges: just inside is the well, just outside is the page.
  const insideTop = at(img, cellCentre(L, 5, VISIBLE_TOP)[0], L.boardY + 2, dpr);
  const outsideTop = at(img, cellCentre(L, 5, VISIBLE_TOP)[0], L.boardY - 4, dpr);
  report.check('just inside the well top edge is well background',
    near(insideTop, WELL_BG), show(insideTop));
  report.check('just outside the well top edge is page background',
    near(outsideTop, PAGE_BG), show(outsideTop));

  // 7. The ghost: drawn at the row the simulation says it will land, and
  //    translucent rather than solid. Sampling where the *renderer* thinks the
  //    ghost goes would be circular, so the row comes from ghostRow().
  const gy = ghostRow(g);
  const shape = SHAPES[g.piece][g.rot];
  const gx = g.x + shape[0];
  const gyy = gy + shape[1];
  report.check('the scene puts the ghost well below the piece',
    gy !== g.y, 'ghost row ' + gy + ', piece row ' + g.y);

  const ghost = c(gx, gyy);
  report.check('the ghost is drawn at ghostRow() (' + gx + ',' + gyy + ')',
    !near(ghost, WELL_BG, 3), show(ghost));
  report.check('the ghost is translucent, not a solid block',
    !near(ghost, rgb(BASE[PIECE.T + 1])), show(ghost));

  // 8. And nothing is drawn below the floor.
  const belowFloor = at(img, cellCentre(L, 4, TOTAL_ROWS - 1)[0],
    boardCellY(L, TOTAL_ROWS) + 3, dpr);
  report.check('nothing is drawn below the last row',
    near(belowFloor, PAGE_BG), show(belowFloor));
}

/* ------------------------------------------------------------ pacing checks */

/** A 60-tick cycle that exercises DAS, ARR, rotation, hold and hard drops. */
function scripted(f, t) {
  const c = t % 60;
  f.left = c < 18;
  f.right = c >= 20 && c < 38;
  f.leftEdge = c === 0;
  f.rightEdge = c === 20;
  f.cwEdge = c === 40;
  f.ccwEdge = c === 42;
  f.holdEdge = c === 44;
  f.hardEdge = c === 46;
  f.softDrop = c >= 52;
}

function measurePacing(deps, seconds) {
  return new Promise((resolve) => {
    const { renderer, perf, log } = deps;
    const h = makeHandling({ das: 6, arr: 2, sdf: 4, dcd: 2 });
    const f = makeInputFrame();
    const lp = makeLoop();
    const fl = { paused: false, over: false };
    let g = makeGame({ seed: 7 });
    resetPerf(perf);

    const target = Math.round(seconds * 60);
    let frames = 0;
    let t = 0;
    let last = 0;
    let restarts = 0;
    let settled = false;
    let beats = 0;

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve({ g, restarts, frames, stalled: frames < target });
    }

    // A page-side bound is a courtesy, not the real guard: WebKit suspends
    // timers along with rAF in an occluded window, so if the page is frozen
    // this never fires. The backend arms a watchdog for that case.
    const guard = setTimeout(finish, (seconds + 10) * 1000);

    function onFrame(now) {
      const dt = last === 0 ? 0 : now - last;
      last = now;
      const droppedBefore = lp.dropped;
      const n = advance(lp, dt);
      if (n > 0) {
        scripted(f, t);
        for (let i = 0; i < n; i++) {
          stepWithInput(g, h, f);
          t++;
        }
      }
      // Restart on top-out so the burst runs for the full duration instead of
      // ending early — which also exercises the restart path under load.
      if (g.status === STATUS.OVER) { g = makeGame({ seed: 7 + restarts++ }); resetPerf(perf); }

      fl.over = false;
      draw(renderer, g, fl);
      recordFrame(perf, dt, renderer.drawMs, n, lp.dropped !== droppedBefore);

      frames++;
      // Heartbeat: distinguishes "rAF never fired" from "rAF fired slowly",
      // which is the difference between an occluded window and a real
      // performance problem. The first frame is logged unconditionally so that
      // "rAF never ran at all" is visible in the output rather than inferred
      // from silence.
      if (frames === 1) log('bench: first rAF frame arrived');
      else if (frames % 60 === 0) log('bench: pacing heartbeat ' + frames + '/' + target);

      if (frames < target) requestAnimationFrame(onFrame);
      else finish();
    }

    requestAnimationFrame(onFrame);
  });
}

/* --------------------------------------------------------------------- entry */

export async function runSelfTest(deps) {
  // Fail loudly on a missing dependency. Without this, a forgotten argument
  // surfaces as "undefined is not an object" thrown from inside a rAF callback,
  // which kills the frame loop — and that looks exactly like an occluded window,
  // so the wrong diagnosis is the easy one to reach.
  for (const key of ['canvas', 'renderer', 'perf', 'log']) {
    if (!deps[key]) throw new Error('selftest: deps.' + key + ' is missing');
  }

  const { log } = deps;
  const failures = [];
  const lines = [];

  const report = (msg) => { lines.push(msg); };
  report.check = (name, pass, detail) => {
    lines.push((pass ? '  ok   ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
    if (!pass) failures.push(name);
  };

  log('bench: render checks');
  checkRender(deps, report);
  for (const l of lines) log(l);
  lines.length = 0;

  log('bench: frame pacing, 5s scripted DAS/ARR/hard-drop burst');
  // WebKit suspends rAF outright for a page it considers hidden, so a stalled
  // pacing run has two very different causes — an occluded window, or a bug
  // that stops the loop rescheduling. Record the page's own view of its
  // visibility so the diagnosis is a fact rather than a guess.
  log('bench: visibility=' + document.visibilityState +
    ' hasFocus=' + document.hasFocus() +
    ' inner=' + window.innerWidth + 'x' + window.innerHeight +
    ' dpr=' + (window.devicePixelRatio || 1));
  const run = await measurePacing(deps, 5);
  const s = stats(deps.perf);
  const budget = meetsBudget(s) && !run.stalled;

  if (run.stalled) {
    log('bench: STALLED after ' + run.frames + ' frames — the window is probably ' +
      'occluded, and WebKit stops rAF when it is. The numbers below are a partial ' +
      'sample and are not a verdict.');
  }

  const summary = 'bench: fps=' + s.fps.toFixed(2) +
    ' mean=' + s.mean.toFixed(2) +
    ' p50=' + s.p50.toFixed(1) +
    ' p99=' + s.p99.toFixed(1) +
    ' max=' + s.max.toFixed(1) +
    ' >33ms=' + s.over33 +
    ' dropped=' + s.dropped +
    ' draw_p99=' + s.drawP99.toFixed(2) +
    ' draw_max=' + s.drawMax.toFixed(2) +
    ' ticks=' + s.ticks +
    ' restarts=' + run.restarts;
  log(summary);

  log('bench: no missed vsync (>33ms), no catch-up clamp, fps at vsync, draw < 8ms -> ' +
    (budget ? 'PASS' : 'FAIL'));
  if (!budget) failures.push(run.stalled ? 'pacing run stalled' : 'frame pacing budget');

  log('bench: verdict ' + (failures.length === 0 ? 'PASS' : 'FAIL (' + failures.length + ')'));
  for (const f of failures) log('bench: failed -> ' + f);

  return failures.length === 0;
}
