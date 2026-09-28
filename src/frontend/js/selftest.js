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
import { MODE, MODE_LIST } from './modes.js';
import { makeHandling, makeInputFrame } from './handling.js';
import { stepWithInput } from './apply.js';
import { makeLoop, advance } from './loop.js';
import { draw, boardCellX, boardCellY, BASE } from './render.js';
import { makePerf, recordFrame, stats, resetPerf, meetsBudget } from './perf.js';
import { makeRecorder, recordTick, finishRecording, buildReplay } from './replay.js';
import { normalizeSettings } from './settings.js';
import { SFX_NAMES } from './sfxgen.js';

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

  // 9. The end-of-run overlay, with a real result. This is the only part of the
  //    panel code the headless tests cannot reach, and it reads `game.result`,
  //    which only exists once a run has ended.
  const over = makeGame({ seed: 3, mode: MODE.SPRINT });
  step(over);
  over.status = STATUS.OVER;
  over.result = {
    mode: 'sprint', reason: 'goal', lines: 40, score: 12345,
    pieces: 61, level: 8, ticks: 3600,
  };
  draw(renderer, over, { paused: false, over: true, banner: '' });

  const img2 = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const dim = at(img2, cellCentre(L, 1, VISIBLE_TOP + 1)[0],
    cellCentre(L, 1, VISIBLE_TOP + 1)[1], dpr);
  report.check('the end-of-run overlay darkens the well',
    dim[0] < 40 && dim[1] < 40 && dim[2] < 50, show(dim));

  // 10. And the paused overlay must not throw on a null result.
  draw(renderer, g, { paused: true, over: false, banner: '' });
  report.check('the paused overlay draws without a result', true, 'no exception');

  // 11. The ghost run's stack. It is drawn as outlines *under* the live board, so
  //     it has to show in the gaps without hiding anything — an outline on the
  //     cell border and an untouched cell centre.
  const ghostGame = makeGame({ seed: 12 });
  step(ghostGame);
  ghostGame.board.rows.fill(0);
  ghostGame.board.colors.fill(0);
  ghostGame.board.top.fill(TOTAL_ROWS);
  setCell(ghostGame.board, 7, TOTAL_ROWS - 1, 1);   // a column the live board leaves empty
  draw(renderer, g, { paused: false, over: false, banner: '' }, ghostGame);

  const img3 = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const stackX = boardCellX(L, 7);
  const stackY = boardCellY(L, TOTAL_ROWS - 1);
  // Sample the stroke's own pixel column, and deliberately not "half a pixel in".
  //
  // `drawStack` strokes at `boardCellX + 0.5` with a 1px line, so the outline
  // covers the single pixel column starting at `stackX` — and `at()` rounds its
  // argument, so `stackX + 0.5` reads pixel `stackX + 1`, one column inside the
  // cell, where there is nothing but background. That off-by-one is why this
  // check was red long before any of the sound work; the renderer was drawing the
  // outline correctly the whole time, and the failure was in the assertion.
  const edge = at(img3, stackX, stackY + L.cell / 2, dpr);
  const centre = at(img3, stackX + L.cell / 2, stackY + L.cell / 2, dpr);

  report.check('the ghost run is outlined under the live board',
    !near(edge, WELL_BG, 4), show(edge));
  report.check('the ghost is an outline, not a fill',
    near(centre, WELL_BG, 4), show(centre));

  // 12. The resting pulse: a grounded piece brightens so the lock-delay window is
  //     visible. Sampled at a cell centre, where the pulse fill lands. Without
  //     this, an instant soft drop lands a piece that vanishes half a second
  //     later with no cue that it was about to lock.
  const pulseCell = cellCentre(L, 4, VISIBLE_TOP + 4);
  g.grounded = false;
  draw(renderer, g, { paused: false, over: false, banner: '' });
  const plainPiece = at(ctx.getImageData(0, 0, canvas.width, canvas.height),
    pulseCell[0], pulseCell[1], dpr);
  g.grounded = true;
  g.lockTimer = 3;   // sin(1.8) is near 1, so the pulse is near its brightest
  draw(renderer, g, { paused: false, over: false, banner: '' });
  const pulsedPiece = at(ctx.getImageData(0, 0, canvas.width, canvas.height),
    pulseCell[0], pulseCell[1], dpr);
  report.check('a grounded piece pulses brighter than a falling one',
    !near(plainPiece, pulsedPiece, 4), show(plainPiece) + ' -> ' + show(pulsedPiece));
  g.grounded = false;

  // 13. The lock flash: the just-locked cells light up. The driver hands the
  //     renderer the piece that locked, because the board alone cannot say which
  //     cells were newest.
  draw(renderer, g, {
    paused: false, over: false, banner: '',
    lockFlash: { piece: PIECE.T, rot: 0, x: 3, y: VISIBLE_TOP + 4, alpha: 1 },
  });
  const flashed = at(ctx.getImageData(0, 0, canvas.width, canvas.height),
    pulseCell[0], pulseCell[1], dpr);
  report.check('a lock flash lights the placed cells',
    !near(flashed, plainPiece, 4), show(flashed) + ' vs ' + show(plainPiece));
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

/* ------------------------------------------------------------- storage checks */

/**
 * A minimal but *real* replay, built from an actual short run rather than
 * hand-written. A hand-written one would only prove the backend accepts the
 * shape I imagined.
 */
function probeReplay() {
  const g = makeGame({ seed: 2024 });
  const h = makeHandling({ das: 4, arr: 2, sdf: Infinity, dcd: 0 });
  const f = makeInputFrame();
  const rec = makeRecorder();
  for (let i = 0; i < 120; i++) {
    if (i === 10) f.hardEdge = true;
    if (i === 40) { f.right = true; f.rightEdge = true; }
    recordTick(rec, f);
    stepWithInput(g, h, f);
    f.hardEdge = false;
    if (g.status === STATUS.OVER) break;
  }
  finishRecording(rec);
  return buildReplay(g, h.cfg, rec.pairs);
}

/**
 * Round-trip every persistence method against the real backend.
 *
 * This is the only way to check a file-writing layer that has no UI for all of
 * it, and it is worth doing: the interesting failure is not "the file is
 * missing" but "the id the page sent back became a path somewhere else".
 *
 * Everything it writes, it removes or restores.
 */
async function checkStorage(deps, report) {
  const { call } = deps;

  // Settings, saved and restored — the user's real settings must survive.
  const before = await call('getSettings');
  await call('saveSettings', {
    settings: { v: 1, mode: 'sprint', handling: { das: 7 }, timing: { are: 3 } },
  });
  const after = await call('getSettings');
  report.check('settings round-trip through disk',
    !!after && after.mode === 'sprint' && after.handling && after.handling.das === 7,
    after ? JSON.stringify(after.handling) : 'null');
  await call('saveSettings', { settings: before || normalizeSettings(null) });

  // A score entry.
  const table = await call('saveScore', {
    entry: { mode: 'selftest', score: 1, lines: 1, ticks: 1, reason: 'goal', date: 0 },
  });
  report.check('saveScore returns the table',
    Array.isArray(table) && table.some((e) => e.mode === 'selftest'),
    Array.isArray(table) ? table.length + ' entries' : 'null');
  report.check('a malformed score is refused',
    (await call('saveScore', { entry: { mode: 'x', score: 'lots' } })) === null,
    'rejected');

  // Replays: save, list, load, delete.
  const saved = await call('saveReplay', { replay: probeReplay() });
  report.check('saveReplay returns an index entry',
    !!saved && typeof saved.id === 'string', saved ? saved.id : 'null');

  if (saved) {
    const list = await call('listReplays');
    report.check('the saved replay is listed',
      Array.isArray(list) && list.some((m) => m.id === saved.id),
      Array.isArray(list) ? list.length + ' replays' : 'null');

    const loaded = await call('loadReplay', { id: saved.id });
    report.check('loadReplay returns the log intact',
      !!loaded && Array.isArray(loaded.log) && loaded.log.length > 0,
      loaded ? loaded.log.length + ' log entries' : 'null');

    // The id becomes a filename, so a traversal attempt must be refused rather
    // than merely sanitised.
    report.check('a path-traversal id is refused',
      (await call('loadReplay', { id: '../settings' })) === null, 'rejected');

    await call('deleteReplay', { id: saved.id });
    const after2 = await call('listReplays');
    report.check('deleteReplay removes it from the index',
      Array.isArray(after2) && !after2.some((m) => m.id === saved.id), 'gone');
    report.check('and the file is really gone',
      (await call('loadReplay', { id: saved.id })) === null, 'gone');
  }
}

/* --------------------------------------------------------------------- entry */

/**
 * Load the sound bank through the real bridge, and play something.
 *
 * This is the check that answers the question the plan could not. The CSP has no
 * `media-src`, which blocks `<audio>` — and the sampler is *not* `<audio>`. On
 * macOS and Windows it is Web Audio inside this very page, and Web Audio playing
 * an already-decoded buffer fetches nothing, so no directive governs it. That
 * reasoning is sound, and reasoning is exactly what this project has learned not
 * to trust: the frame-rate claim was "verified" the same way and turned out to
 * be wrong. So the assumption gets measured, in the real webview, under the real
 * policy, through the real gate.
 *
 * The play call is awaited here, unlike in the frame loop. The bench can afford
 * to wait, and a *resolved* call is the thing worth asserting: it proves the
 * gate entry, the bridge and the mixer all agree. In the loop the same call is
 * fire-and-forget, because a sound that blocks a frame is worse than one that is
 * late.
 */
async function checkAudio(deps, report) {
  const entries = deps.gen();
  report.check('the bank renders ' + entries.length + ' effects',
    entries.length === SFX_NAMES.length,
    entries.length === SFX_NAMES.length ? '' :
      'expected ' + SFX_NAMES.length);

  const ready = await deps.sfx.loadBank(entries);
  report.check('the sampler decodes the whole bank', ready,
    ready ? '' : 'loadSfx refused one of them — see the log above');

  if (ready) {
    const played = await deps.call('sampler.play', { name: 'ui', vol: 0.25, rate: 1 });
    report.check('sampler.play is allowed and the mixer takes it',
      played !== null && played !== undefined,
      played ? 'voice ' + played.id : 'refused — check the api gate');

    // A second one, louder and longer, so a human in the room hears the check
    // pass rather than having to trust the log.
    await deps.call('sampler.play', { name: 'clear', vol: 0.6, rate: 1 });
  }
  return ready;
}

/**
 * The title screen, checked as DOM rather than as pixels.
 *
 * The bench cannot read pixels for a DOM overlay — it is not on the canvas — so
 * this checks the two things that would otherwise need a human and that would
 * fail *silently*:
 *
 *  1. **The class the adapter toggles is the one the stylesheet keys off.** A
 *     typo on either side of that agreement produces an invisible menu, no error
 *     anywhere, and a game that appears to boot straight into a run. Comparing
 *     the *computed* style is what makes this a real check rather than a
 *     tautology about a string.
 *  2. That the rows are actually built, one per mode.
 *
 * Driven through the real menu instance, but only its harmless verbs — opening,
 * moving the highlight, closing. Choosing a row would start a game in the middle
 * of the bench.
 */
function checkMenu(deps, report) {
  const root = document.getElementById('menu');
  report.check('the menu element is in the document', !!root);
  if (!root) return;

  deps.menu.set();
  deps.menu.open();

  const rows = root.querySelectorAll('.menu-item');
  report.check('the menu builds a row per mode, plus Settings',
    rows.length === MODE_LIST.length + 1,
    rows.length + ' rows, expected ' + (MODE_LIST.length + 1));

  const openDisplay = getComputedStyle(root).display;
  report.check('an open menu is actually displayed', openDisplay !== 'none',
    'display: ' + openDisplay);

  const before = deps.menu.selection();
  deps.menu.act('down');
  report.check('the highlight moves', deps.menu.selection() !== before,
    before + ' -> ' + deps.menu.selection());

  // The quit confirmation. Escape opens it and Escape again cancels — checked
  // through the real instance and the computed style, because a typo on either
  // side of the `menu-confirm-on` contract would leave a prompt that never
  // appears, and nothing else would report it.
  const card = root.querySelector('.menu-confirm');
  report.check('the menu builds a quit confirmation', !!card);
  deps.menu.act('close');
  const confirmOpen = card ? getComputedStyle(card).display : 'none';
  report.check('escape opens the quit confirmation',
    deps.menu.isConfirming() && confirmOpen !== 'none',
    'confirming=' + deps.menu.isConfirming() + ', display: ' + confirmOpen);
  deps.menu.act('close');
  const confirmShut = card ? getComputedStyle(card).display : 'none';
  report.check('and escape again cancels it',
    !deps.menu.isConfirming() && confirmShut === 'none',
    'confirming=' + deps.menu.isConfirming() + ', display: ' + confirmShut);

  deps.menu.close();
  const shutDisplay = getComputedStyle(root).display;
  report.check('and a closed menu takes no space and no keys',
    shutDisplay === 'none', 'display: ' + shutDisplay);
}

/**
 * The in-game Restart button, checked the same way as the menu.
 *
 * Same failure mode as the menu's class contract, and the same silence: a typo
 * on either side of the `hud-open` agreement leaves a button that never appears,
 * or one that never goes away and sits over the title screen. The computed style
 * is what makes this a real check rather than a string comparison.
 */
function checkHud(deps, report) {
  const root = document.getElementById('hud');
  report.check('the hud element is in the document', !!root);
  if (!root) return;

  const button = root.querySelector('.hud-btn');
  report.check('the hud builds a Restart button', !!button);
  report.check('and it is labelled', !!button && button.textContent.length > 0,
    button ? button.textContent : 'missing');

  // The driver calls `setVisible` every frame. A name that drifts here would
  // throw inside the frame loop, which kills rAF and leaves a blank window —
  // exactly the failure the bench exists to catch, and one it did *not* catch
  // when this method was missing, because the bench never runs the driver loop.
  report.check('the hud exposes setVisible, which the driver calls',
    typeof deps.hud.setVisible === 'function', typeof deps.hud.setVisible);

  deps.hud.show();
  const openDisplay = getComputedStyle(root).display;
  report.check('a shown hud is actually displayed', openDisplay !== 'none',
    'display: ' + openDisplay);

  deps.hud.hide();
  const shutDisplay = getComputedStyle(root).display;
  report.check('and a hidden hud takes no space and no keys',
    shutDisplay === 'none', 'display: ' + shutDisplay);
}

export async function runSelfTest(deps) {
  // Fail loudly on a missing dependency. Without this, a forgotten argument
  // surfaces as "undefined is not an object" thrown from inside a rAF callback,
  // which kills the frame loop — and that looks exactly like an occluded window,
  // so the wrong diagnosis is the easy one to reach.
  for (const key of ['canvas', 'renderer', 'perf', 'log', 'call', 'sfx', 'gen', 'menu', 'hud']) {
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

  // Audio first. It is fast, and it is the newest and least-proven thing here —
  // if the sampler cannot start, that is the most interesting failure in the run.
  log('bench: sound bank');
  await checkAudio(deps, report);
  for (const l of lines) log(l);
  lines.length = 0;

  log('bench: title screen');
  checkMenu(deps, report);
  for (const l of lines) log(l);
  lines.length = 0;

  log('bench: in-game hud');
  checkHud(deps, report);
  for (const l of lines) log(l);
  lines.length = 0;

  log('bench: render checks');
  checkRender(deps, report);
  for (const l of lines) log(l);
  lines.length = 0;

  log('bench: persistence round trip');
  await checkStorage(deps, report);
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
