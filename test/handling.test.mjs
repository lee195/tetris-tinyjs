/**
 * Headless tests for input handling — the competitive core.
 *
 *   node test/handling.test.mjs
 *
 * These target the things that fail *silently*: a shift that arrives one frame
 * late, a DAS charge that gets cleared when it shouldn't, a tap that vanishes
 * between two ticks. None of those throw; they just feel wrong to a player, so
 * they have to be pinned by assertion.
 *
 * `handling.js`, `apply.js` and the pure parts of `input.js` have no DOM
 * dependencies, so all of this runs under Node. Only `attachInput()` — the
 * listener wiring — needs a webview.
 */

import { COLS, SPAWN_X } from '../src/frontend/js/constants.js';
import { BOUNDS } from '../src/frontend/js/pieces.js';
import { makeRng } from '../src/frontend/js/rng.js';
import {
  makeGame, step, move, softDrop, ghostRow, gameHash, STATUS, spendReset,
} from '../src/frontend/js/game.js';
import {
  makeHandling, makeIntent, makeInputFrame, tick, onLock, shiftBlocked,
  resetHandling, setHandling, SOFT_DROP,
} from '../src/frontend/js/handling.js';
import { applyIntent, stepWithInput } from '../src/frontend/js/apply.js';
import { makeInput, pollInput, resetInput } from '../src/frontend/js/input.js';
import { ok, eq, group, done } from './harness.mjs';

/* ---------------------------------------------------------------- helpers */

/** A held direction, as the adapter would produce it on the press tick. */
function pressed(dir) {
  const f = makeInputFrame();
  if (dir === -1) { f.left = true; f.leftEdge = true; }
  else { f.right = true; f.rightEdge = true; }
  return f;
}

/** The same key, still down, on subsequent ticks. */
function holding(dir) {
  const f = makeInputFrame();
  if (dir === -1) f.left = true;
  else f.right = true;
  return f;
}

/** Run `n` ticks of a held direction, returning the ticks that shifted. */
function shiftTicks(h, f, n) {
  const at = [];
  for (let i = 1; i <= n; i++) if (tick(h, f).shift !== 0) at.push(i);
  return at;
}

/**
 * Copy an intent's fields out of the reused object.
 *
 * Needed whenever a test compares the result of two ticks: `tick()` returns the
 * same instance every time, so keeping the reference and reading it later gives
 * you the later tick's values.
 */
function snapshot(it) {
  return {
    shift: it.shift,
    toWall: it.toWall,
    softDrop: it.softDrop,
    rotateCW: it.rotateCW,
    rotateCCW: it.rotateCCW,
    hardDrop: it.hardDrop,
    hold: it.hold,
  };
}

/* ------------------------------------------------------- press and DAS */

group('press, DAS and ARR');

{
  const h = makeHandling({ das: 10, arr: 2 });
  const f = pressed(-1);
  const first = tick(h, f);
  eq(first.shift, -1, 'a fresh press shifts immediately');
  ok(!first.toWall, 'the press shift is a single cell, not a wall slide');

  // DAS must expire before the repeats start, then ARR paces them.
  const at = shiftTicks(h, holding(-1), 20);
  eq(at.join(','), '10,12,14,16,18,20', 'DAS expires at frame 10, then ARR 2 paces the repeats');
}

{
  // DAS 0 means the repeats begin on the very next frame.
  const h = makeHandling({ das: 0, arr: 1 });
  tick(h, pressed(1));
  const at = shiftTicks(h, holding(1), 5);
  eq(at.join(','), '1,2,3,4,5', 'DAS 0 with ARR 1 shifts every frame');
}

{
  // Releasing must clear the charge — otherwise a tap would leave the piece
  // auto-shifting forever.
  const h = makeHandling({ das: 3, arr: 1 });
  tick(h, pressed(-1));
  shiftTicks(h, holding(-1), 6);
  ok(h.charged, 'the charge is running');
  tick(h, makeInputFrame());          // everything released
  ok(!h.charged, 'releasing clears the charge');
  eq(h.dir, 0, 'and clears the direction');
  eq(shiftTicks(h, makeInputFrame(), 5).length, 0, 'and nothing shifts afterwards');
}

/* ------------------------------------------------------------ ARR 0 */

group('ARR 0 is a distinct path');

{
  const h = makeHandling({ das: 6, arr: 0 });
  const f = pressed(-1);
  const it = tick(h, f);
  eq(it.shift, -1, 'the press shifts one cell');
  ok(!it.toWall, 'and is NOT a wall slide — DAS has not expired yet');

  const mid = shiftTicks(h, holding(-1), 5);
  eq(mid.length, 0, 'nothing shifts while DAS is still charging');

  const after = tick(h, holding(-1));
  eq(after.shift, -1, 'once DAS expires, the shift fires');
  ok(after.toWall, 'and it is flagged as a slide to the wall');

  // It keeps asking, which is harmless: the piece is already at the wall.
  ok(tick(h, holding(-1)).toWall, 'and it stays a wall slide while held');
}

/* ------------------------------------------------- the parked counter */

group('a blocked shift fires the instant it clears');

{
  const h = makeHandling({ das: 1, arr: 6 });
  const f = holding(-1);
  tick(h, pressed(-1));
  tick(h, f);                       // das 1 -> charged
  ok(h.charged, 'DAS has expired');

  const at = shiftTicks(h, f, 6);
  eq(at.length, 1, 'the next shift fires after ARR');
  eq(at[0], 6, 'which is 6 frames later');

  // `applyIntent` calls this when the move is refused.
  shiftBlocked(h);
  eq(h.mov, 5, 'a blocked shift parks the counter one frame short of ARR');
  ok(tick(h, f).shift !== 0, 'so it retries on the very next tick');
}

{
  // Before DAS expires there is nothing to park — the charge just continues.
  const h = makeHandling({ das: 10, arr: 4 });
  tick(h, pressed(1));
  tick(h, holding(1));
  shiftBlocked(h);
  eq(h.mov, 1, 'a block before DAS expires does not park the counter');
}

{
  // With ARR 0 it already retries every tick; parking would be redundant.
  const h = makeHandling({ das: 0, arr: 0 });
  tick(h, pressed(1));
  tick(h, holding(1));
  shiftBlocked(h);
  ok(tick(h, holding(1)).toWall, 'ARR 0 keeps retrying regardless');
}

/* -------------------------------------------------------- taps and edges */

group('taps that begin and end between two ticks');

{
  // The most common competitive input. Polling held-state alone would drop it.
  const h = makeHandling({ das: 10, arr: 2 });
  const f = makeInputFrame();
  f.leftEdge = true;
  f.left = false;                    // pressed and released inside the tick
  eq(tick(h, f).shift, -1, 'a tap that already ended still shifts');
}

{
  // Harder: release and re-press inside one tick, while the direction is
  // already the active one. Without the edge check this would be swallowed.
  const h = makeHandling({ das: 10, arr: 2 });
  tick(h, pressed(-1));
  const f = holding(-1);
  f.leftEdge = true;                 // released and pressed again this tick
  eq(tick(h, f).shift, -1, 'a re-press inside one tick still shifts');
  ok(!h.charged, 'and restarts the DAS charge');
}

{
  const h = makeHandling({ das: 10, arr: 2 });
  const f = makeInputFrame();
  f.hardEdge = true;
  ok(tick(h, f).hardDrop, 'a hard-drop edge is reported');
  ok(!tick(h, f).hardDrop, 'and is consumed, so it does not repeat');
}

{
  // The reason edge consumption matters: the fixed-timestep loop can run
  // several ticks inside one rendered frame (catch-up after a stall) while
  // input is polled once. A one-shot press must fire exactly once across all of
  // them, while held state must persist.
  const h = makeHandling({ das: 10, arr: 2 });
  const f = makeInputFrame();
  f.left = true;
  f.leftEdge = true;
  f.hardEdge = true;

  // Snapshots, not references: the intent is a reused object, so holding it
  // across a second tick would read the second tick's values.
  const t1 = snapshot(tick(h, f));
  const t2 = snapshot(tick(h, f));

  ok(t1.hardDrop, 'the press fires on the first tick of the frame');
  ok(!t2.hardDrop, 'and not again on the second');
  eq(t2.shift, 0, 'nor does the direction re-press, which would restart DAS');
  eq(h.mov, 1, 'while the DAS charge advances across both ticks');
}

{
  // Same shape, with the direction held across a whole catch-up burst.
  const h = makeHandling({ das: 5, arr: 2 });
  const f = makeInputFrame();
  f.right = true;
  f.rightEdge = true;
  eq(tick(h, f).shift, 1, 'the press shifts');
  eq(tick(h, f).shift, 0, 'the second catch-up tick does not shift again');
  eq(h.mov, 1, 'and the charge is one frame in, not reset');
}

/* --------------------------------------------------- direction resolution */

group('direction resolution');

{
  const h = makeHandling({ das: 10, arr: 2 });
  tick(h, pressed(-1));
  eq(h.dir, -1, 'left is in charge');

  const f = makeInputFrame();
  f.left = true;                     // still holding left
  f.right = true; f.rightEdge = true;  // and pressing right
  eq(tick(h, f).shift, 1, 'a fresh press turns the piece around');
  eq(h.dir, 1, 'right is now in charge');

  const g = makeInputFrame();
  g.left = true;                     // right released, left still held
  eq(tick(h, g).shift, -1, 'releasing the newer key falls back to the one still held');
}

{
  // Both held with no new press: the more recently pressed stays in charge.
  const h = makeHandling({ das: 10, arr: 2 });
  tick(h, pressed(1));
  const f = holding(1);
  f.left = true;
  tick(h, f);
  eq(h.dir, 1, 'with both held, the most recent press keeps control');
}

/* --------------------------------------------------------- soft drop (SDF) */

group('soft drop');

{
  const h = makeHandling({ sdf: Infinity });
  const f = makeInputFrame();
  f.softDrop = true;
  eq(tick(h, f).softDrop, SOFT_DROP.TO_FLOOR, 'infinite SDF drops straight to the floor');
}

{
  const h = makeHandling({ sdf: 3 });
  const f = makeInputFrame();
  f.softDrop = true;
  eq(tick(h, f).softDrop, SOFT_DROP.NONE, 'SDF 3 does not drop on the first frame');
  eq(tick(h, f).softDrop, SOFT_DROP.NONE, 'nor the second');
  eq(tick(h, f).softDrop, SOFT_DROP.ONE, 'it drops one cell on the third');
  eq(tick(h, f).softDrop, SOFT_DROP.NONE, 'and the timer restarts');
}

{
  const h = makeHandling({ sdf: 3 });
  const f = makeInputFrame();
  f.softDrop = true;
  tick(h, f); tick(h, f);
  f.softDrop = false;
  tick(h, f);
  f.softDrop = true;
  eq(tick(h, f).softDrop, SOFT_DROP.NONE, 'releasing resets the soft-drop timer');
}

{
  const h = makeHandling({ sdf: Infinity });
  const f = makeInputFrame();
  f.softDrop = true; f.hardEdge = true;
  const it = tick(h, f);
  ok(it.hardDrop, 'a hard drop is reported');
  eq(it.softDrop, SOFT_DROP.NONE, 'and supersedes the soft drop');
}

/* --------------------------------------------------- lock, charge and DCD */

group('the DAS charge survives a lock');

{
  const h = makeHandling({ das: 3, arr: 2, dcd: 0 });
  tick(h, pressed(1));
  shiftTicks(h, holding(1), 4);
  ok(h.charged, 'the charge is running');
  onLock(h);
  ok(h.charged, 'it survives the lock');
  eq(h.dir, 1, 'and so does the direction');
  eq(h.cut, 0, 'with DCD off, nothing is armed');
}

group('DCD (DAS cut delay)');

{
  const h = makeHandling({ das: 3, arr: 2, dcd: 8 });
  tick(h, pressed(1));
  shiftTicks(h, holding(1), 4);
  ok(h.charged, 'the charge is running');
  onLock(h);
  eq(h.cut, 8, 'DCD arms on the lock');

  const during = shiftTicks(h, holding(1), 8);
  eq(during.length, 0, 'no shift fires during the cut');

  const after = shiftTicks(h, holding(1), 2);
  eq(after.join(','), '2', 'the first shift lands ARR frames after the cut ends');
}

{
  // DCD must not arm when there is no charge to cut.
  const h = makeHandling({ das: 10, arr: 2, dcd: 8 });
  tick(h, pressed(1));
  onLock(h);
  eq(h.cut, 0, 'DCD does not arm when DAS is still charging');
}

{
  const h = makeHandling({ das: 3, arr: 2, dcd: 8 });
  tick(h, pressed(1));
  shiftTicks(h, holding(1), 4);
  onLock(h);
  const f = makeInputFrame();        // released
  tick(h, f);
  eq(h.cut, 0, 'releasing clears a pending cut');
}

/* ------------------------------------------------------ the intent object */

group('the intent is reused (zero allocation per tick)');

{
  const h = makeHandling();
  const a = tick(h, makeInputFrame());
  const b = tick(h, makeInputFrame());
  ok(a === b, 'tick() returns the same object every time');

  tick(h, pressed(-1));
  eq(b.shift, -1, 'and it carries the current tick, not a stale one');

  const c = tick(h, makeInputFrame());
  eq(c.shift, 0, 'and is cleared at the start of the next tick');
  ok(!c.hardDrop && c.softDrop === SOFT_DROP.NONE, 'every field is cleared');
}

{
  // makeIntent is exported so tests and callers can build one without a game.
  const it = makeIntent();
  ok(it.shift === 0 && !it.toWall && it.softDrop === SOFT_DROP.NONE,
    'a fresh intent is empty');
}

/* ------------------------------------------------------------- reset / config */

group('reset and live config changes');

{
  const h = makeHandling({ das: 3, arr: 1 });
  tick(h, pressed(1));
  shiftTicks(h, holding(1), 5);
  resetHandling(h);
  ok(h.dir === 0 && h.mov === 0 && !h.charged && h.cut === 0 && h.lastDir === 0,
    'resetHandling clears all movement state');
  eq(h.intent.shift, 0, 'and clears the intent');
}

{
  const h = makeHandling({ das: 10, arr: 2 });
  tick(h, pressed(1));
  shiftTicks(h, holding(1), 3);
  setHandling(h, { das: 1, arr: 1 });
  ok(h.charged === false && h.mov === 3, 'setHandling keeps the charge in progress');
  eq(h.cfg.das, 1, 'and applies the new DAS');
}

{
  // Nonsense config must not produce a NaN-driven stall.
  const h = makeHandling({ das: NaN, arr: -4, dcd: undefined });
  eq(h.cfg.das, 10, 'a NaN DAS falls back to the default');
  eq(h.cfg.arr, 0, 'a negative ARR clamps to 0');
  eq(h.cfg.dcd, 0, 'an undefined DCD falls back to the default');
  ok(h.cfg.sdf === Infinity, 'and SDF defaults to instant');
}

/* ------------------------------------------------- the DOM adapter's pure half */

group('input adapter (the parts that run without a DOM)');

{
  const inp = makeInput();
  const f = makeInputFrame();

  inp.held.left = true;
  inp.edges.left = true;
  ok(pollInput(inp, f) === f, 'pollInput fills the caller frame in place');
  ok(f.left, 'held state is copied');
  ok(f.leftEdge, 'the edge latch is copied');
  ok(!inp.edges.left, 'and consumed');

  pollInput(inp, f);
  ok(!f.leftEdge, 'the edge does not fire a second time');
  ok(f.left, 'while the key is still reported as held');
}

{
  // A press that happened just before focus loss must not fire on resume.
  const inp = makeInput();
  const f = makeInputFrame();
  inp.held.left = true;
  inp.edges.hardDrop = true;
  resetInput(inp);
  pollInput(inp, f);
  ok(!f.left, 'resetInput clears held keys');
  ok(!f.hardEdge, 'and clears pending edge latches');
}

{
  const inp = makeInput();
  inp.held.softDrop = true;
  const f = makeInputFrame();
  pollInput(inp, f);
  ok(f.softDrop, 'soft drop is a held key, not an edge');
}

/* ----------------------------------------------------- against a real game */

group('driving the simulation');

{
  // The headline integration: hold right and the piece travels to the wall.
  const g = makeGame({ seed: 1 });
  const h = makeHandling({ das: 4, arr: 2 });
  const f = pressed(1);
  stepWithInput(g, h, f);            // spawn tick — nothing to move yet
  const f2 = holding(1);
  for (let i = 0; i < 60; i++) stepWithInput(g, h, f2);

  const wall = COLS - 1 - BOUNDS[g.piece][g.rot].maxX;
  eq(g.x, wall, 'the piece auto-shifted to the right wall');
  const settled = g.x;
  for (let i = 0; i < 30; i++) stepWithInput(g, h, f2);
  eq(g.x, settled, 'and stays there while the key is held');
}

{
  // Input must not reach a piece that does not exist yet.
  const g = makeGame({ seed: 2 });
  const h = makeHandling({ das: 2, arr: 1 });
  eq(g.status, STATUS.SPAWN, 'a new game is waiting to spawn');
  const f = pressed(1);
  stepWithInput(g, h, f);
  eq(g.x, SPAWN_X, 'the input is not applied during the spawn delay');
  ok(h.dir === 1, 'but the direction is already registered');
}

{
  // Holding a direction through a lock keeps moving the next piece — this is
  // the DAS-charging behaviour, and it is easy to break by resetting on lock.
  const g = makeGame({ seed: 3 });
  const h = makeHandling({ das: 3, arr: 1, dcd: 0 });
  stepWithInput(g, h, pressed(1));
  const f = holding(1);
  for (let i = 0; i < 10; i++) stepWithInput(g, h, f);
  ok(h.charged, 'DAS is charged');
  ok(g.x > SPAWN_X, 'and the piece has moved');

  const drop = holding(1);
  drop.hardEdge = true;
  stepWithInput(g, h, drop);
  eq(g.piece, -1, 'the hard drop locked the piece');
  ok(h.charged, 'the charge survived the lock');

  let guard = 0;
  while (g.piece === -1 && guard++ < 60) stepWithInput(g, h, f);
  ok(g.piece !== -1, 'a new piece spawned');
  const x0 = g.x;
  for (let i = 0; i < 3; i++) stepWithInput(g, h, f);
  ok(g.x > x0, 'and it moved right with no fresh press');
}

{
  // A multi-cell slide is ONE player action, so it costs ONE lock reset.
  // Charging per cell would let an ARR 0 player burn the budget in one press.
  const g = makeGame({ seed: 5 });
  const h = makeHandling({ das: 0, arr: 0 });
  step(g);                            // spawn
  while (softDrop(g)) { /* to the floor */ }
  eq(ghostRow(g), g.y, 'the piece is resting on the floor');

  const it = makeIntent();
  it.shift = -1;
  it.toWall = true;
  const before = g.moveResets;
  applyIntent(g, h, it);
  eq(g.moveResets, before + 1, 'a wall slide costs exactly one lock reset');
  eq(g.x, -BOUNDS[g.piece][g.rot].minX, 'and it reached the wall');
  ok(g.x < SPAWN_X, 'having crossed more than one cell');
}

{
  // A blocked shift must park the counter, end to end through applyIntent.
  const g = makeGame({ seed: 9 });
  const h = makeHandling({ das: 1, arr: 8 });
  step(g);
  while (move(g, 1)) { /* to the right wall */ }
  eq(h.charged, false, 'nothing is charged yet');

  stepWithInput(g, h, pressed(1));    // press at the wall: blocked
  const f = holding(1);
  stepWithInput(g, h, f);             // das 1 -> charged, blocked again
  ok(h.charged, 'DAS expired against the wall');
  eq(h.mov, 7, 'and the refused shift parked the counter');
  ok(tick(h, f).shift !== 0, 'so the next tick retries immediately');
}

{
  // applyIntent is inert unless a piece is falling.
  const g = makeGame({ seed: 7 });
  const h = makeHandling();
  const it = makeIntent();
  it.shift = 1;
  it.hardDrop = true;
  ok(!applyIntent(g, h, it), 'applyIntent reports nothing was applied during spawn');
  eq(g.piece, -1, 'and does not touch the game');
}

{
  // softDrop resets the gravity accumulator, so a soft drop never doubles up
  // with a gravity step in the same tick.
  const g = makeGame({ seed: 8 });
  const h = makeHandling({ sdf: 1 });
  step(g);
  const y0 = g.y;
  const f = makeInputFrame();
  f.softDrop = true;
  stepWithInput(g, h, f);
  eq(g.y, y0 + 1, 'soft drop moves exactly one cell per tick');
}

/* ------------------------------------------------------------ determinism */

group('determinism with input (the replay contract)');

{
  /**
   * A realistic input log: directions are held for a while, with edges only on
   * the transition. Generated from a fixed seed so the log itself is identical
   * across runs.
   */
  function play(seed, cfg, ticks) {
    const g = makeGame({ seed });
    const h = makeHandling(cfg);
    const f = makeInputFrame();
    const rnd = makeRng(0x5eed);
    let prevLeft = false;
    let prevRight = false;

    for (let t = 0; t < ticks; t++) {
      const r = rnd();
      const left = r < 0.30;
      const right = r >= 0.30 && r < 0.60;
      f.left = left;
      f.right = right;
      f.leftEdge = left && !prevLeft;
      f.rightEdge = right && !prevRight;
      prevLeft = left;
      prevRight = right;
      f.softDrop = r > 0.75;
      f.cwEdge = r > 0.60 && r < 0.66;
      f.ccwEdge = r > 0.66 && r < 0.70;
      f.hardEdge = r > 0.96;
      f.holdEdge = r > 0.92 && r <= 0.94;
      stepWithInput(g, h, f);
    }
    return { hash: gameHash(g), g };
  }

  const cfg = { das: 6, arr: 2, sdf: 4, dcd: 2 };
  const a = play(4242, cfg, 3000);
  const b = play(4242, cfg, 3000);
  eq(a.hash, b.hash, 'the same seed and input log produce the same state');
  eq(a.g.lines, b.g.lines, 'line counts match');
  eq(a.g.pieces, b.g.pieces, 'piece counts match');
  ok(a.g.pieces > 3, 'the log actually played several pieces');

  const c = play(4243, cfg, 3000);
  ok(c.hash !== a.hash, 'a different seed diverges');

  // Proves the handling config is genuinely part of the simulation.
  const d = play(4242, { das: 0, arr: 0, sdf: Infinity, dcd: 0 }, 3000);
  ok(d.hash !== a.hash, 'different handling settings produce a different game');
}

/* --------------------------------------------------------------- summary */

done('input handling');
