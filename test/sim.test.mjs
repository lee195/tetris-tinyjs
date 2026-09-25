/**
 * Headless tests for the simulation. Run with:
 *
 *   node test/sim.test.mjs
 *
 * No framework, no dependencies — the sim modules are pure ES modules with no
 * DOM or `tiny` references, so Node can import them directly. This is the fast
 * loop; the webview is only needed once rendering exists.
 */

import { COLS, TOTAL_ROWS, FULL_ROW, PIECE, PIECE_COUNT, TICK_MS } from '../src/frontend/js/constants.js';
import { makeRng, makeBag } from '../src/frontend/js/rng.js';
import { SHAPES, BOUNDS, SPAWN_Y, JLSTZ_KICKS, I_KICKS } from '../src/frontend/js/pieces.js';
import {
  makeBoard, setCell, getCell, isFullRow, collides, place, clearLines,
  boardHash, recomputeTop, countFullRows, isEmpty,
} from '../src/frontend/js/board.js';
import {
  tryRotate, tryMove, dropRow, spawnPosition, gravityFrames,
  LOCK_DELAY, MOVE_RESET_LIMIT,
} from '../src/frontend/js/rules.js';
import {
  makeGame, step, move, rotate, softDrop, hardDrop, holdPiece, ghostRow,
  gameHash, STATUS, setLevel,
} from '../src/frontend/js/game.js';
import { makeLoop, advance, alpha, MAX_CATCHUP_MS } from '../src/frontend/js/loop.js';
import { ok, eq, group, done } from './harness.mjs';

/* ------------------------------------------------------------------- rng */

group('rng');

{
  const a = makeRng(1234);
  const b = makeRng(1234);
  let same = true;
  for (let i = 0; i < 100; i++) if (a() !== b()) same = false;
  ok(same, 'same seed produces the same sequence');

  const c = makeRng(1235);
  const d = makeRng(1234);
  ok(c() !== d(), 'different seeds diverge');

  // Values stay in [0,1)
  const r = makeRng(7);
  let inRange = true;
  for (let i = 0; i < 1000; i++) { const v = r(); if (v < 0 || v >= 1) inRange = false; }
  ok(inRange, 'rng output is in [0,1)');
}

{
  // Bag boundaries align to 7 draws, so each consecutive group of 7 is a permutation.
  const bag = makeBag(99);
  let allBagsValid = true;
  for (let b = 0; b < 50; b++) {
    const seen = new Set();
    for (let i = 0; i < PIECE_COUNT; i++) seen.add(bag.next());
    if (seen.size !== PIECE_COUNT) allBagsValid = false;
  }
  ok(allBagsValid, 'every group of 7 draws contains all 7 pieces');

  const bag2 = makeBag(99);
  const bag3 = makeBag(99);
  let sameSeq = true;
  for (let i = 0; i < 100; i++) if (bag2.next() !== bag3.next()) sameSeq = false;
  ok(sameSeq, 'bag sequence is reproducible from the seed');

  const bag4 = makeBag(100);
  const bag5 = makeBag(99);
  let diff = false;
  for (let i = 0; i < 50; i++) if (bag4.next() !== bag5.next()) diff = true;
  ok(diff, 'different seeds give different piece orders');
}

/* ---------------------------------------------------------------- pieces */

group('pieces');

{
  for (let p = 0; p < PIECE_COUNT; p++) {
    for (let r = 0; r < 4; r++) {
      eq(SHAPES[p][r].length, 8, 'piece ' + p + ' rot ' + r + ' has 4 cells');
    }
  }
  // O is rotation-invariant
  let oSame = true;
  for (let r = 1; r < 4; r++) {
    for (let i = 0; i < 8; i++) if (SHAPES[PIECE.O][r][i] !== SHAPES[PIECE.O][0][i]) oSame = false;
  }
  ok(oSame, 'O piece is identical across rotations');

  // Bounds agree with the shape data
  let boundsOk = true;
  for (let p = 0; p < PIECE_COUNT; p++) {
    for (let r = 0; r < 4; r++) {
      const s = SHAPES[p][r], b = BOUNDS[p][r];
      for (let i = 0; i < 8; i += 2) {
        if (s[i] < b.minX || s[i] > b.maxX || s[i + 1] < b.minY || s[i + 1] > b.maxY) boundsOk = false;
      }
    }
  }
  ok(boundsOk, 'BOUNDS encloses every cell of every rotation');

  // Spawn puts the topmost cell on the first visible row
  let spawnOk = true;
  for (let p = 0; p < PIECE_COUNT; p++) {
    if (SPAWN_Y[p] + BOUNDS[p][0].minY !== 20) spawnOk = false;
  }
  ok(spawnOk, 'every piece spawns with its topmost cell on the first visible row');
}

/* ------------------------------------------------------------ srs tables */

group('srs kick tables (transcription + y-flip)');

{
  // The published tables use y-UP; this engine uses y-DOWN. Verify the flip
  // landed, since a sign error here is silent and would subtly break wall kicks.
  const j01 = JLSTZ_KICKS['0>1'];
  eq(j01.length, 10, 'JLSTZ 0>1 has 5 offsets');
  eq(j01[0], 0, 'JLSTZ 0>1 kick 1 x is 0');
  eq(j01[1], 0, 'JLSTZ 0>1 kick 1 y is 0 (identity first)');
  eq(j01[2], -1, 'JLSTZ 0>1 kick 2 x is -1');
  eq(j01[3], 0, 'JLSTZ 0>1 kick 2 y is 0');
  // published: (-1, +1) with y up  ->  (-1, -1) with y down
  eq(j01[4], -1, 'JLSTZ 0>1 kick 3 x is -1');
  eq(j01[5], -1, 'JLSTZ 0>1 kick 3 y flipped +1 -> -1');

  const i01 = I_KICKS['0>1'];
  eq(i01.length, 10, 'I 0>1 has 5 offsets');
  eq(i01[2], -2, 'I 0>1 kick 2 x is -2');
  // published: (-2, -1) with y up  ->  (-2, +1) with y down
  eq(i01[6], -2, 'I 0>1 kick 4 x is -2');
  eq(i01[7], 1, 'I 0>1 kick 4 y flipped -1 -> +1');
}

/* ----------------------------------------------------------------- board */

group('board');

{
  const b = makeBoard();
  ok(isEmpty(b), 'new board is empty');

  setCell(b, 3, 39, 1);
  ok(getCell(b, 3, 39), 'set/get round-trips');
  eq(b.top[3], 39, 'column height cache updates on set');
  eq(b.top[4], TOTAL_ROWS, 'untouched column reports empty');

  setCell(b, 3, 39, 0);
  ok(!getCell(b, 3, 39), 'clearing a cell works');
  recomputeTop(b);
  eq(b.top[3], TOTAL_ROWS, 'recompute clears a stale height');

  // Row-full test
  const b2 = makeBoard();
  for (let x = 0; x < COLS; x++) setCell(b2, x, 39, 1);
  ok(isFullRow(b2, 39), 'a row with every column set is full');
  setCell(b2, 4, 39, 0);
  ok(!isFullRow(b2, 39), 'a row with a gap is not full');

  // clearLines drops rows above down and reports the count
  const b3 = makeBoard();
  for (let x = 0; x < COLS; x++) setCell(b3, x, 39, 1);   // full, bottom
  setCell(b3, 0, 38, 2);                                   // lone cell above
  eq(countFullRows(b3), 1, 'one full row counted');
  eq(clearLines(b3), 1, 'clearLines returns the count');
  ok(getCell(b3, 0, 39), 'the row above dropped into the cleared row');
  ok(!getCell(b3, 0, 38), 'the vacated row is empty');
  eq(b3.top[0], 39, 'height cache is recomputed after a clear');

  // Two non-adjacent full rows
  const b4 = makeBoard();
  for (let x = 0; x < COLS; x++) { setCell(b4, x, 39, 1); setCell(b4, x, 37, 1); }
  setCell(b4, 5, 38, 3);
  eq(clearLines(b4), 2, 'two separated full rows both clear');
  ok(getCell(b4, 5, 39), 'the survivor row fell to the bottom');

  // Hash is stable and sensitive
  const h1 = makeBoard();
  const h2 = makeBoard();
  eq(boardHash(h1), boardHash(h2), 'empty boards hash equal');
  setCell(h2, 0, 39, 1);
  ok(boardHash(h1) !== boardHash(h2), 'one cell changes the hash');
}

/* ------------------------------------------------------------- collision */

group('collision');

{
  const b = makeBoard();
  const t0 = SHAPES[PIECE.T][0];

  ok(!collides(b, t0, 3, 20), 'legal position does not collide');
  ok(collides(b, t0, -1, 20), 'off the left wall collides');
  ok(collides(b, t0, 9, 20), 'off the right wall collides');
  ok(collides(b, t0, 3, TOTAL_ROWS), 'below the floor collides');
  ok(!collides(b, t0, 3, TOTAL_ROWS - 2), 'resting on the floor does not collide');

  setCell(b, 4, 21, 1);
  ok(collides(b, t0, 3, 20), 'overlapping a filled cell collides');
}

/* -------------------------------------------------------------- rotation */

group('rotation + wall kicks');

{
  const b = makeBoard();

  // A real SRS kick: a vertical I flush against the left wall, rotated CW.
  // The identity and (-1,0) offsets are both blocked; (+2,0) lands it legally.
  const r = tryRotate(b, PIECE.I, 1, -2, 20, 1);
  ok(r !== null, 'I against the left wall kicks rather than failing');
  eq(r.rot, 2, 'I kick lands in rotation 2');
  eq(r.x, 0, 'I kick shifts to x=0 (the +2 offset)');
  ok(!collides(b, SHAPES[PIECE.I][r.rot], r.x, r.y), 'kicked position is legal');

  // O never moves on rotation
  const o = tryRotate(b, PIECE.O, 0, 3, 20, 1);
  eq(o.x, 3, 'O rotation keeps x');
  eq(o.y, 20, 'O rotation keeps y');
  eq(o.rot, 1, 'O rotation advances the rotation index');

  // Rotation is blocked when no kick fits
  const packed = makeBoard();
  for (let y = 20; y < 24; y++) for (let x = 0; x < COLS; x++) setCell(packed, x, y, 1);
  eq(tryRotate(packed, PIECE.T, 0, 3, 20, 1), null, 'rotation fails when fully enclosed');

  // Invariant: any non-null rotation result is a legal position.
  const rnd = makeRng(4242);
  let allLegal = true;
  for (let trial = 0; trial < 400; trial++) {
    const bb = makeBoard();
    for (let i = 0; i < 60; i++) {
      setCell(bb, (rnd() * COLS) | 0, 20 + ((rnd() * 20) | 0), 1);
    }
    const piece = (rnd() * PIECE_COUNT) | 0;
    const rot = (rnd() * 4) | 0;
    const x = ((rnd() * 12) | 0) - 1;
    const y = 20 + ((rnd() * 4) | 0);
    const res = tryRotate(bb, piece, rot, x, y, rnd() < 0.5 ? 1 : -1);
    if (res && collides(bb, SHAPES[piece][res.rot], res.x, res.y)) allLegal = false;
  }
  ok(allLegal, 'no rotation ever returns a colliding position (400 random boards)');
}

/* ---------------------------------------------------------------- gravity */

group('gravity and drop');

{
  const b = makeBoard();
  eq(dropRow(b, PIECE.O, 0, 3, 20), TOTAL_ROWS - 2, 'O drops to rest on the floor');

  setCell(b, 3, 30, 1);
  // O occupies rows y and y+1, so its bottom edge rests on 29 — one row above
  // the blocker at 30 — giving a box origin of 28.
  const d = dropRow(b, PIECE.O, 0, 3, 20);
  eq(d, 28, 'O rests one row above a single blocking cell');

  // The column-height cache must agree with a brute-force drop
  const rnd = makeRng(777);
  let cacheOk = true;
  for (let trial = 0; trial < 200; trial++) {
    const bb = makeBoard();
    for (let i = 0; i < 40; i++) setCell(bb, (rnd() * COLS) | 0, 25 + ((rnd() * 15) | 0), 1);
    const piece = (rnd() * PIECE_COUNT) | 0;
    const x = 3;
    const y = 20;
    const viaCache = dropRow(bb, piece, 0, x, y);
    // brute force
    let brute = y;
    while (!collides(bb, SHAPES[piece][0], x, brute + 1)) brute++;
    if (viaCache !== brute) cacheOk = false;
  }
  ok(cacheOk, 'cached-height drop matches brute force (200 random boards)');

  // gravityFrames matches the guideline curve
  eq(gravityFrames(1), 60, 'level 1 gravity is 60 frames per cell (1 cell/sec)');
  ok(gravityFrames(10) < gravityFrames(1), 'gravity speeds up with level');
  ok(gravityFrames(20) >= 1, 'gravity never goes below one frame per cell');
}

/* ------------------------------------------------------------ game state */

group('game state machine');

{
  // A fresh game spawns a piece immediately
  const g = makeGame({ seed: 1 });
  eq(g.status, STATUS.SPAWN, 'game starts awaiting spawn');
  step(g);
  eq(g.status, STATUS.FALLING, 'first step spawns a piece');
  eq(g.pieces, 1, 'piece counter increments');
  ok(g.piece >= 0 && g.piece < PIECE_COUNT, 'a real piece is active');
  eq(g.queue.length, 5, 'queue is kept topped up');

  // Gravity: a piece on an empty board falls
  const g2 = makeGame({ seed: 2 });
  step(g2);
  const y0 = g2.y;
  for (let i = 0; i < 60; i++) step(g2);
  ok(g2.y > y0, 'piece falls under gravity');

  // Lock delay: a resting piece locks after LOCK_DELAY frames, not before
  const g3 = makeGame({ seed: 3 });
  step(g3);
  hardDrop(g3);              // lands and locks immediately
  ok(g3.piece === -1, 'hard drop locks the piece immediately');
  eq(g3.status, STATUS.SPAWN, 'locking moves to the spawn delay');

  const g4 = makeGame({ seed: 4 });
  step(g4);
  // walk it to the floor with gravity only
  for (let i = 0; i < 200 && g4.status === STATUS.FALLING; i++) {
    if (ghostRow(g4) === g4.y) {
      const before = g4.pieces;
      const lockTimerAtRest = g4.lockTimer;
      for (let k = 0; k < LOCK_DELAY - 1; k++) step(g4);
      ok(g4.piece !== -1, 'piece does not lock before the lock delay elapses');
      step(g4);
      ok(g4.pieces === before + 1 || g4.status === STATUS.CLEARING || g4.piece === -1,
        'piece locks once the lock delay elapses');
      break;
    }
    step(g4);
  }
}

/* ------------------------------------------------------------- line clear */

group('line clearing');

{
  const g = makeGame({ seed: 5 });
  step(g);
  // Fill the bottom row except the four cells a horizontal I would occupy.
  for (let x = 0; x < COLS; x++) setCell(g.board, x, TOTAL_ROWS - 1, 1);
  for (let x = 3; x <= 6; x++) setCell(g.board, x, TOTAL_ROWS - 1, 0);
  g.board.top.fill(0);
  recomputeTop(g.board);

  g.piece = PIECE.I;
  g.rot = 0;
  g.x = 3;
  g.y = TOTAL_ROWS - 1;
  eq(countFullRows(g.board), 0, 'row is not full before the drop');

  const before = g.lines;
  hardDrop(g);
  eq(g.status, STATUS.CLEARING, 'a full row enters the clear delay');
  eq(g.pendingRows.length, 1, 'one row is pending');
  for (let i = 0; i < 30; i++) step(g);
  eq(g.lines, before + 1, 'line counter advanced');
  eq(countFullRows(g.board), 0, 'the row is gone');
}

/* ------------------------------------------------------------ determinism */

group('determinism (the replay contract)');

{
  // A deterministic action script, driven by its own RNG so the script itself
  // is identical across runs regardless of game seed.
  function playScript(seed, ticks) {
    const g = makeGame({ seed });
    const act = makeRng(0xbeef);
    for (let t = 0; t < ticks; t++) {
      step(g);
      const r = act();
      if (g.status === STATUS.FALLING) {
        if (r < 0.15) move(g, -1);
        else if (r < 0.30) move(g, 1);
        else if (r < 0.38) rotate(g, 1);
        else if (r < 0.44) rotate(g, -1);
        else if (r < 0.50) softDrop(g);
        else if (r < 0.53) hardDrop(g);
        else if (r < 0.55) holdPiece(g);
      }
    }
    return { hash: gameHash(g), g };
  }

  const a = playScript(2024, 4000);
  const b = playScript(2024, 4000);
  eq(a.hash, b.hash, 'same seed + same actions -> identical state hash');
  eq(a.g.lines, b.g.lines, 'line counts match');
  eq(a.g.pieces, b.g.pieces, 'piece counts match');
  ok(a.g.pieces > 5, 'the script actually played several pieces');

  const c = playScript(2025, 4000);
  ok(c.hash !== a.hash, 'a different seed produces a different game');

  // Hold is once per piece
  const g = makeGame({ seed: 11 });
  step(g);
  ok(holdPiece(g), 'hold works when unused');
  ok(!holdPiece(g), 'hold is refused a second time for the same piece');

  // setLevel changes gravity
  const g2 = makeGame({ seed: 12 });
  const f1 = g2.gravityFrames;
  setLevel(g2, 15);
  ok(g2.gravityFrames < f1, 'raising the level speeds gravity');
}

/* ------------------------------------------------------------------ loop */

group('fixed-timestep loop');

{
  const l = makeLoop();
  eq(advance(l, TICK_MS), 1, 'one tick of elapsed time yields one step');
  eq(advance(l, TICK_MS * 2), 2, 'two ticks of elapsed time yield two steps');
  eq(advance(l, TICK_MS * 0.4), 0, 'a partial tick yields no step');
  eq(advance(l, TICK_MS * 0.6), 1, 'partial ticks accumulate into a whole one');

  // A stall is dropped, not simulated. Asserted as a range rather than an exact
  // tick count: the accumulator subtracts TICK_MS repeatedly, so its floating
  // point path differs from a direct division and can land either side of an
  // exact boundary. The property that matters is "a bounded burst, not 120 ticks".
  const l2 = makeLoop();
  const n = advance(l2, 2000);
  const capTicks = Math.ceil(MAX_CATCHUP_MS / TICK_MS);
  ok(n >= 1 && n <= capTicks, 'a 2s stall is clamped to the cap (' + n + ' ticks, cap ' + capTicks + ')');
  ok(n < 2000 / TICK_MS / 4, 'the clamp drops far more time than it simulates');
  eq(l2.dropped, 1, 'the clamp is recorded');

  // Many small deltas total the same number of ticks as one big one
  const l3 = makeLoop();
  let total = 0;
  for (let i = 0; i < 60; i++) total += advance(l3, 1000 / 60);
  ok(total >= 59 && total <= 61, 'a second of 60Hz frames yields ~60 ticks');

  // Nonsense deltas are inert
  const l4 = makeLoop();
  eq(advance(l4, NaN), 0, 'NaN delta yields no ticks');
  eq(advance(l4, -5), 0, 'negative delta yields no ticks');

  // alpha stays in range
  const l5 = makeLoop();
  advance(l5, TICK_MS * 0.5);
  ok(alpha(l5) >= 0 && alpha(l5) < 1, 'alpha is a valid interpolation fraction');
}

/* --------------------------------------------------------------- summary */

done('simulation');
