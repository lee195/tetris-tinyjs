/**
 * Headless tests for the renderer's geometry and the frame statistics.
 *
 *   node test/render.test.mjs
 *
 * The drawing functions need a canvas and are verified by pixel readback in the
 * app itself (`js/selftest.js`, run with TETRIS_BENCH=1). What is testable here
 * is the arithmetic underneath: the layout mapping, the preview centring, and
 * the percentile maths — and that last one matters because an off-by-one in a
 * percentile silently flatters every benchmark that follows.
 */

import { COLS, TOTAL_ROWS, VISIBLE_ROWS, VISIBLE_TOP, PIECE_COUNT } from '../src/frontend/js/constants.js';
import { BOUNDS } from '../src/frontend/js/pieces.js';
import {
  computeLayout, boardCellX, boardCellY, pieceBoxOrigin, lighten,
  BASE, LIGHT, MIN_CELL,
} from '../src/frontend/js/render.js';
import {
  makePerf, recordFrame, stats, resetPerf, meetsBudget,
} from '../src/frontend/js/perf.js';
import { ok, eq, group, done } from './harness.mjs';

/* ------------------------------------------------------------------ layout */

group('layout');

{
  const L = computeLayout(960, 640);

  ok(Number.isInteger(L.cell) && L.cell >= MIN_CELL, 'cell size is an integer at least MIN_CELL');
  eq(L.boardW, COLS * L.cell, 'the well is COLS cells wide');
  eq(L.boardH, VISIBLE_ROWS * L.cell, 'the well is VISIBLE_ROWS cells tall');
  ok(L.panelX >= L.boardX + L.boardW, 'the side panel does not overlap the well');
  ok(L.totalW <= 960, 'the layout fits the viewport width');
  ok(L.boardH <= 640, 'the well fits the viewport height');
  ok(L.boardX >= 0 && L.boardY >= 0, 'nothing is pushed off-screen');

  // Centred to within a pixel of rounding.
  const slackL = L.boardX;
  const slackR = 960 - (L.panelX + L.panelW);
  ok(Math.abs(slackL - slackR) <= 1, 'the well and panel are horizontally centred');
  const slackT = L.boardY;
  const slackB = 640 - (L.boardY + L.boardH);
  ok(Math.abs(slackT - slackB) <= 1, 'the well is vertically centred');
}

{
  // A narrow, tall window is width-bound: it must fit the width and leave the
  // height partly unused, rather than overflowing sideways.
  const narrow = computeLayout(400, 1200);
  ok(narrow.totalW <= 400, 'a narrow viewport still fits the width');
  ok(narrow.cell * VISIBLE_ROWS < 1200, 'and is width-bound, not height-bound');
  ok(computeLayout(1920, 1080).cell >= computeLayout(960, 640).cell,
    'a bigger viewport never shrinks the cell');
}

{
  // Degenerate viewports must not produce NaN or a negative cell — a zero-width
  // window happens for real during a resize.
  const tiny = computeLayout(1, 1);
  ok(Number.isFinite(tiny.cell) && tiny.cell >= MIN_CELL, 'a 1x1 viewport still yields a usable cell');
  ok(Number.isFinite(tiny.boardX) && Number.isFinite(tiny.boardY), 'and finite coordinates');
  eq(computeLayout(0, 0).cell, MIN_CELL, 'a zero-size viewport clamps to MIN_CELL');
  eq(computeLayout(-50, -50).cell, MIN_CELL, 'and so does a negative one');
}

/* -------------------------------------------------------- cell coordinates */

group('cell coordinates');

{
  const L = computeLayout(960, 640);

  eq(boardCellX(L, 0), L.boardX, 'column 0 is the left edge of the well');
  eq(boardCellX(L, 1), L.boardX + L.cell, 'columns advance by one cell');
  eq(boardCellX(L, COLS), L.boardX + L.boardW, 'the last column ends at the right edge');

  // The buffer offset. Losing this subtraction draws a plausible-looking board
  // twenty rows in the wrong place, so it is worth pinning explicitly.
  eq(boardCellY(L, VISIBLE_TOP), L.boardY, 'row VISIBLE_TOP is the top of the well');
  eq(boardCellY(L, VISIBLE_TOP + 1), L.boardY + L.cell, 'visible rows advance by one cell');
  eq(boardCellY(L, TOTAL_ROWS), L.boardY + L.boardH, 'the last row ends at the bottom edge');
  eq(boardCellY(L, VISIBLE_TOP - 1), L.boardY - L.cell, 'a buffer row maps above the well');
}

/* --------------------------------------------------------- preview geometry */

group('piece previews');

{
  const SIZE = 8, BOXW = 140, BOXH = 48, BX = 100, BY = 200;
  let allFit = true;
  let allCentred = true;

  for (let p = 0; p < PIECE_COUNT; p++) {
    for (let r = 0; r < 4; r++) {
      const o = pieceBoxOrigin(p, r, SIZE, BX, BY, BOXW, BOXH);
      const b = BOUNDS[p][r];
      const x0 = o.x + b.minX * SIZE;
      const y0 = o.y + b.minY * SIZE;
      const x1 = o.x + (b.maxX + 1) * SIZE;
      const y1 = o.y + (b.maxY + 1) * SIZE;

      if (x0 < BX || y0 < BY || x1 > BX + BOXW || y1 > BY + BOXH) allFit = false;
      if (Math.abs((x0 - BX) - (BX + BOXW - x1)) > 1) allCentred = false;
      if (Math.abs((y0 - BY) - (BY + BOXH - y1)) > 1) allCentred = false;
    }
  }

  ok(allFit, 'every piece and rotation stays inside its preview box');
  ok(allCentred, 'and is centred on its occupied cells, not its bounding box');
}

/* ------------------------------------------------------------------ palette */

group('palette');

{
  eq(lighten('#000000', 46), '#2e2e2e', 'lighten adds per channel');
  eq(lighten('#ffffff', 46), '#ffffff', 'and clamps at white');
  eq(lighten('#3ec6e0', 46), '#6cf4ff', 'and produces the expected highlight');
  eq(lighten('#3ec6e0', 0), '#3ec6e0', 'a zero delta is a no-op');

  eq(BASE.length, PIECE_COUNT + 1, 'the palette is indexed by pieceId + 1');
  eq(BASE[0], '#000000', 'index 0 is the empty cell');
  eq(LIGHT[0], '#000000', 'and its highlight is left alone');

  let distinct = new Set(BASE.slice(1)).size;
  eq(distinct, PIECE_COUNT, 'every piece has its own colour');
}

/* ----------------------------------------------------------- frame statistics */

group('frame statistics');

{
  // Nearest-rank percentiles. For ten samples p99 IS the maximum — pinning that
  // makes the definition explicit rather than accidental.
  const p = makePerf(10);
  const vals = [16, 16, 16, 16, 17, 17, 17, 17, 17, 18];
  for (const v of vals) recordFrame(p, v, 0.2, 1, false);

  const s = stats(p);
  eq(s.n, 10, 'all samples are recorded');
  ok(Math.abs(s.mean - 16.7) < 1e-6, 'the mean is the arithmetic mean');
  ok(Math.abs(s.fps - 1000 / 16.7) < 0.01, 'fps is derived from the mean interval');
  eq(s.p50, 17, 'p50 is the median');
  eq(s.p99, 18, 'p99 of ten samples is the largest');
  eq(s.max, 18, 'max is the largest');
  eq(s.over33, 0, 'no frame is over 33.4ms');
}

{
  // The case that separates nearest-rank from the common wrong version: with
  // 100 samples, p99 is the 99th value, NOT the maximum.
  const p = makePerf(100);
  for (let i = 1; i <= 100; i++) recordFrame(p, i, 0, 1, false);
  const s = stats(p);
  eq(s.p99, 99, 'p99 of 1..100 is 99, not 100 — nearest rank, not "the max"');
  eq(s.max, 100, 'max is still 100');
  eq(s.p50, 50, 'p50 is the 50th value');
}

{
  // The ring must keep the most recent samples, not the first ones.
  const p = makePerf(4);
  for (const v of [1, 2, 3, 4, 5, 6]) recordFrame(p, v, 0, 1, false);
  const s = stats(p);
  eq(s.n, 4, 'the ring holds only capacity samples');
  eq(s.max, 6, 'the newest sample is retained');
  eq(s.p50, 4, 'and the oldest has been overwritten');
}

{
  const p = makePerf(10);
  recordFrame(p, 16, 1.5, 1, false);
  recordFrame(p, 40, 2.5, 2, true);
  recordFrame(p, 34, 0.5, 1, false);
  const s = stats(p);
  eq(s.over33, 2, 'frames over 33.4ms are counted');
  eq(s.ticks, 4, 'ticks accumulate across frames');
  eq(s.dropped, 1, 'dropped frames are counted');
  eq(s.worst, 40, 'the worst frame is tracked');
  eq(s.drawP99, 2.5, 'draw times are summarised separately');
  eq(s.drawMax, 2.5, 'and their max too');
}

{
  const p = makePerf(4);
  const out = {};
  ok(stats(p, out) === out, 'stats fills the caller object in place (no allocation)');
  eq(out.n, 0, 'and reports zero samples');
  eq(out.fps, 0, 'with fps 0 rather than NaN');
  eq(out.p99, 0, 'and p99 0 rather than NaN');

  resetPerf(p);
  recordFrame(p, 16, 0, 1, false);
  resetPerf(p);
  eq(stats(p).n, 0, 'resetPerf clears the ring');
  eq(stats(p).ticks, 0, 'and the counters');
}

{
  // The gate is "no missed vsync", not a sub-vsync p99 — a 60Hz display cannot
  // deliver intervals below ~16.7ms, so requiring p99 < 16.7ms would fail every
  // healthy run. That last assertion pins the correction.
  const good = { over33: 0, dropped: 0, fps: 60.1, drawMax: 1 };

  ok(meetsBudget(good), 'a healthy 60Hz run passes');
  ok(!meetsBudget({ over33: 1, dropped: 0, fps: 60.1, drawMax: 1 }), 'a missed vsync fails');
  ok(!meetsBudget({ over33: 0, dropped: 1, fps: 60.1, drawMax: 1 }), 'a catch-up clamp fails');
  ok(!meetsBudget({ over33: 0, dropped: 0, fps: 40, drawMax: 1 }), 'a throttled frame rate fails');
  ok(!meetsBudget({ over33: 0, dropped: 0, fps: 60.1, drawMax: 12 }), 'a draw over half a frame fails');

  ok(meetsBudget({ over33: 0, dropped: 0, fps: 60.1, drawMax: 1, p99: 18, max: 21 }),
    'a p99 of 18ms is healthy at 60Hz and must not fail the budget');
}

/* --------------------------------------------------------------- summary */

done('renderer geometry and frame stats');
