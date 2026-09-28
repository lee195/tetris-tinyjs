/**
 * Headless tests for the sound-effect decisions.
 *
 *   node test/sfx.test.mjs
 *
 * Split deliberately into two halves, because they need different kinds of test.
 *
 * **Derivations run through the real `stepWithInput`.** Whether a tick produced a
 * lock, a rotation or a hold is a claim about the simulation, and the way to test
 * it is to drive the simulation. Hand-built "previous state, next state" pairs
 * are exactly how a wrong predicate passes: the pair encodes the author's belief
 * about what the sim does, which is the thing in doubt. Two of the predicates
 * this module started with were wrong in ways only a real run exposes — a hard
 * drop at ARE 0 hides its lock, and a rotate followed by a shift hides behind
 * `lastAction === 'move'`.
 *
 * **Mappings are unit-tested on crafted state.** Which sound a clear gets, how
 * the pitch tracks the combo, that a level-up needs the line count to move —
 * those are decisions about data, and crafting the data is clearer than playing
 * a hundred lines to reach a level boundary.
 */

import { makeGame, step, setTiming, STATUS, PIECE } from '../src/frontend/js/game.js';
import { makeHandling, makeInputFrame, makeIntent } from '../src/frontend/js/handling.js';
import { stepWithInput, applyIntent } from '../src/frontend/js/apply.js';
import { pick, makeSfxState, makeSfx, SFX, uiSound, sfxNamesAgree } from '../src/frontend/js/sfx.js';
import { SFX_NAMES } from '../src/frontend/js/sfxgen.js';
import { ok, eq, group, done } from './harness.mjs';

/* ------------------------------------------------------------------ helpers */

/** A game and the machinery to drive it, with timing pinned so ticks are exact. */
function setup(opts) {
  const o = opts || {};
  const game = makeGame({ seed: o.seed === undefined ? 5 : o.seed, mode: o.mode || 'marathon' });
  setTiming(game, { are: o.are === undefined ? 0 : o.are, lineClearDelay: o.lineClearDelay || 0 });
  const handling = makeHandling({ das: o.das === undefined ? 10 : o.das, arr: 2, sdf: Infinity, dcd: o.dcd || 0 });
  const input = makeInputFrame();
  const sfx = makeSfxState();
  return { game, handling, input, sfx };
}

/** Advance `n` ticks, collecting every sound decision. */
function run(ctx, n, each) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (each) each(ctx, i);
    const it = stepWithInput(ctx.game, ctx.handling, ctx.input);
    const d = pick(ctx.sfx, ctx.game, it);
    if (d) out.push(d);
  }
  return out;
}

/** Get the game to a state where a piece is falling and nothing else is pending. */
function toFalling(ctx) {
  for (let i = 0; i < 12 && ctx.game.status !== STATUS.FALLING; i++) {
    stepWithInput(ctx.game, ctx.handling, ctx.input);
  }
  return ctx.game.status === STATUS.FALLING;
}

/** A game object shaped for `pick`, with only the fields it reads. */
function fakeGame(over) {
  return Object.assign({ level: 1, lines: 0, status: STATUS.FALLING, lastClear: null }, over);
}

/** A fresh `lastClear` as `scoreClear` produces one. */
function clear(over) {
  return Object.assign({ lines: 0, tspin: 0, combo: -1, backToBack: false, points: 0, label: '' }, over);
}

/* -------------------------------------------------- the names must line up */

group('the names agree');

{
  // The sampler REJECTS on an unknown name rather than playing nothing, so a
  // rename drifting these two modules apart would turn every event into a
  // rejected promise — reported, but silent to the player.
  const bad = sfxNamesAgree();
  eq(bad.length, 0, 'every SFX name is renderable' + (bad.length ? ': ' + bad.join(', ') : ''));
  eq(SFX_NAMES.length, 9, 'the bank has nine effects');
}

/* ------------------------------------------------------------ the lock edge */

group('the lock edge');

{
  // The case that was broken: a hard drop locks INSIDE applyIntent, so at ARE 0
  // the following step spawns in the same tick and `piece === -1` never appears.
  // Deriving the lock from that marker missed every hard drop at the default ARE.
  for (const are of [0, 1, 3]) {
    const ctx = setup({ are });
    ok(toFalling(ctx), 'a piece is falling before the drop (are ' + are + ')');
    const before = ctx.game.lastClear;
    ctx.input.hardEdge = true;
    stepWithInput(ctx.game, ctx.handling, ctx.input);
    ok(ctx.game.lastClear !== before,
      'a hard-drop lock is visible from outside the tick (are ' + are + ')');
  }
}

{
  // The boundary pin: at ARE 0 the lock and the spawn really do share a tick, so
  // the test above is not passing by accident of a longer delay.
  const ctx = setup({ are: 0 });
  toFalling(ctx);
  const pieceBefore = ctx.game.piece;
  ctx.input.hardEdge = true;
  stepWithInput(ctx.game, ctx.handling, ctx.input);
  ok(ctx.game.piece !== pieceBefore && ctx.game.piece !== -1,
    'at ARE 0 the next piece has already spawned, so piece === -1 was never usable');

  // And with a delay, the marker does survive — which is why the old predicate
  // looked correct when it was written.
  const slow = setup({ are: 3 });
  toFalling(slow);
  slow.input.hardEdge = true;
  stepWithInput(slow.game, slow.handling, slow.input);
  eq(slow.game.piece, -1, 'with ARE 3 the marker is still visible, hence the old code seemed fine');
}

{
  // A gravity lock must still be detected — it was never broken, and a fix that
  // traded one path for the other would be worse than the bug.
  const ctx = setup({ are: 0 });
  let locks = 0;
  for (const d of run(ctx, 40000, () => {})) if (d.name === SFX.LOCK) locks++;
  ok(locks > 5, 'gravity locks are detected over a long run  [' + locks + ' locks]');
}

{
  // One lock, one sound. A second lock event without an intervening spawn would
  // mean the identity comparison is firing on something that is not a lock.
  const ctx = setup({ are: 0 });
  let lockEvents = 0;
  const events = run(ctx, 6000, () => {});
  for (const d of events) if (d.name === SFX.LOCK) lockEvents++;
  ok(lockEvents <= ctx.game.pieces,
    'no more lock sounds than pieces spawned  [' + lockEvents + ' sounds, ' +
    ctx.game.pieces + ' pieces]');
}

/* ----------------------------------------------------------------- actions */

group('actions come from the intent, not from the state');

{
  // A rotate followed by a shift in the same tick. `apply.js` applies rotate
  // then shift on purpose, and `move` sets lastAction = 'move' — so the
  // `lastAction === 'rotate'` predicate this module started with went silent
  // here, which is what happens whenever a player rotates while holding a
  // direction.
  const ctx = setup({});
  toFalling(ctx);
  ctx.input.cwEdge = true;
  ctx.input.right = true;
  const it = stepWithInput(ctx.game, ctx.handling, ctx.input);
  eq(it.didRotate, true, 'a rotate followed by a shift still reports the rotate');
  eq(ctx.game.lastAction, 'move', 'and lastAction really did become "move", so it was unusable');

  const d = pick(ctx.sfx, ctx.game, it);
  // The shift is not sonified — it repeats every ARR frames while held, so a
  // sound per shift would machine-gun.
  eq(d && d.name, SFX.ROTATE, 'and the tick sounds like a rotate');
}

{
  // A rotate while the game will not accept input. The outcome flags must be
  // cleared before the early return, or the previous tick's rotate re-fires.
  const ctx = setup({});
  toFalling(ctx);
  ctx.input.cwEdge = true;
  stepWithInput(ctx.game, ctx.handling, ctx.input);   // a real rotate

  const it = makeIntent();
  it.rotateCW = true;
  ctx.game.status = STATUS.SPAWN;
  applyIntent(ctx.game, ctx.handling, it);
  eq(it.didRotate, false, 'a rotate the game refuses reports nothing');
  eq(it.didHold, false, 'and neither does a refused hold');
  eq(it.didHardDrop, false, 'nor a refused hard drop');
}

{
  // A geometrically blocked rotate: the board is filled except one column, so
  // the piece has nowhere to rotate into and every SRS kick fails.
  const ctx = setup({});
  const rows = ctx.game.board.rows;
  const COL = 4;
  for (let y = 0; y < rows.length; y++) rows[y] = 0x3ff & ~(1 << COL);
  ctx.game.piece = PIECE.I;
  ctx.game.rot = 1;
  ctx.game.x = COL;
  ctx.game.y = 30;
  ctx.game.status = STATUS.FALLING;

  const it = makeIntent();
  it.rotateCW = true;
  applyIntent(ctx.game, ctx.handling, it);
  eq(it.didRotate, false, 'a blocked rotation reports nothing');

  // Sanity: the same call on an open board does rotate, so the assertion above
  // is about the block and not about the setup being inert.
  const open = setup({});
  open.game.piece = PIECE.I;
  open.game.rot = 1;
  open.game.x = COL;
  open.game.y = 30;
  open.game.status = STATUS.FALLING;
  const it2 = makeIntent();
  it2.rotateCW = true;
  applyIntent(open.game, open.handling, it2);
  eq(it2.didRotate, true, 'while the same rotation on an open board succeeds');
}

{
  // Hold: once per piece, and a second press within the same piece does nothing.
  const ctx = setup({});
  toFalling(ctx);
  ctx.input.holdEdge = true;
  const first = stepWithInput(ctx.game, ctx.handling, ctx.input);
  eq(first.didHold, true, 'the first hold of a piece reports');

  for (let i = 0; i < 5; i++) stepWithInput(ctx.game, ctx.handling, ctx.input);
  ctx.input.holdEdge = true;
  const second = stepWithInput(ctx.game, ctx.handling, ctx.input);
  eq(second.didHold, false, 'and a second hold of the same piece does not');
}

{
  // A hard drop that travels no distance still locks, so it must still report —
  // gating on the distance would drop it.
  const ctx = setup({});
  const rows = ctx.game.board.rows;
  for (let x = 0; x < 10; x++) rows[0] |= 1 << x;    // a floor to rest on
  ctx.game.piece = PIECE.O;
  ctx.game.rot = 0;
  ctx.game.x = 0;
  ctx.game.y = 30;
  ctx.game.status = STATUS.FALLING;

  const it = makeIntent();
  it.hardDrop = true;
  applyIntent(ctx.game, ctx.handling, it);
  eq(it.didHardDrop, true, 'a zero-distance hard drop still reports');
}

{
  // A hold that tops the run out, in the same tick as a hard drop. `holdPiece`
  // ends the game, so `hardDrop` returns without dropping — and the drop must
  // not be reported.
  //
  // The spawn area is rows 19-22, not the top of the array. Pieces spawn at the
  // buffer/visible boundary (`SPAWN_Y` is 19 or 20), with the twenty-row buffer
  // above them — so filling rows 0-3 blocks nothing at all. The game also has to
  // be in FALLING first, or `applyIntent` returns before reaching the hold.
  const ctx = setup({});
  ok(toFalling(ctx), 'a piece is falling before the hold');
  const rows = ctx.game.board.rows;
  for (let y = 19; y <= 22; y++) rows[y] = 0x3ff;   // block the spawn area

  const it = makeIntent();
  it.hold = true;
  it.hardDrop = true;
  applyIntent(ctx.game, ctx.handling, it);
  eq(ctx.game.status, STATUS.OVER, 'the hold topped the run out');
  eq(it.didHardDrop, false, 'and the drop that never happened is not reported');
}

/* ----------------------------------------------------------------- catch-up */

group('a catch-up frame');

{
  // The fixed-timestep loop runs several ticks per rendered frame after a stall,
  // while the keyboard is polled once. `tick()` consumes the edges, so a
  // one-shot must fire on exactly one of those ticks.
  const ctx = setup({});
  toFalling(ctx);
  ctx.input.cwEdge = true;                 // latched once, for the whole burst
  let rotates = 0;
  for (let i = 0; i < 5; i++) {
    const it = stepWithInput(ctx.game, ctx.handling, ctx.input);
    const d = pick(ctx.sfx, ctx.game, it);
    if (d && d.name === SFX.ROTATE) rotates++;
  }
  eq(rotates, 1, 'one latched rotate across five catch-up ticks sounds once');
}

/* ------------------------------------------------------ mapping: what sound */

group('which sound');

{
  const sfx = makeSfxState();
  const g = fakeGame({ lastClear: clear({ lines: 1, combo: -1 }) });
  const d = pick(sfx, g, null);
  eq(d.name, SFX.CLEAR, 'a line clear sounds like a clear');

  // A lock with no clear is the commonest event, and must not be mistaken for a
  // clear — `lastClear` is assigned on every lock, including a zero-line one.
  const g2 = fakeGame({ lastClear: clear({ lines: 0 }) });
  const sfx2 = makeSfxState();
  const d2 = pick(sfx2, g2, null);
  eq(d2.name, SFX.LOCK, 'a lock with no clear sounds like a lock, not a clear');

  // A T-spin that clears nothing still scores, so it must still sound — and it
  // outranks a plain clear.
  const g3 = fakeGame({ lastClear: clear({ lines: 0, tspin: 2 }) });
  const sfx3 = makeSfxState();
  const d3 = pick(sfx3, g3, null);
  eq(d3.name, SFX.TSPIN, 'a T-spin with no clear still sounds, and as a T-spin');

  const g4 = fakeGame({ lastClear: clear({ lines: 2, tspin: 2 }) });
  const sfx4 = makeSfxState();
  eq(pick(sfx4, g4, null).name, SFX.TSPIN, 'and a T-spin that does clear outranks the clear');

  // A clear outranks the lock in the same tick — one sound per tick, and the
  // clear is the direct consequence of what the player just did.
  const g5 = fakeGame({ lastClear: clear({ lines: 4 }) });
  const sfx5 = makeSfxState();
  eq(pick(sfx5, g5, null).name, SFX.CLEAR, 'a clear suppresses the lock sound for that tick');
}

{
  // A hard drop is a lock too, and the lock branch runs first. Without an
  // explicit hard-drop case inside that branch, `SFX.HARD_DROP` is unreachable
  // in play: every hard drop locks, so the lock sound would swallow it. This is
  // the case the earlier tests missed — they only fed `didHardDrop` with no lock.
  const it = makeIntent();
  it.didHardDrop = true;

  const sfx = makeSfxState();
  const g = fakeGame({ lastClear: clear({ lines: 0 }) });
  eq(pick(sfx, g, it).name, SFX.HARD_DROP,
    'a hard drop that locks sounds like a hard drop, not a lock');

  // Clear and T-spin still outrank it: they are the more informative outcome.
  const sfx2 = makeSfxState();
  const g2 = fakeGame({ lastClear: clear({ lines: 1 }) });
  eq(pick(sfx2, g2, it).name, SFX.CLEAR,
    'but a hard drop that clears still sounds like a clear');

  const sfx3 = makeSfxState();
  const g3 = fakeGame({ lastClear: clear({ lines: 0 }) });
  eq(pick(sfx3, g3, null).name, SFX.LOCK,
    'and an auto-lock with no hard drop is still a lock');
}

{
  // Pitch rises with the combo, so a small bank does not sound repetitive.
  const low = pick(makeSfxState(), fakeGame({ lastClear: clear({ lines: 1, combo: -1 }) }), null);
  const high = pick(makeSfxState(), fakeGame({ lastClear: clear({ lines: 1, combo: 6 }) }), null);
  ok(high.rate > low.rate, 'a longer combo sounds higher  [' + low.rate.toFixed(2) +
    ' -> ' + high.rate.toFixed(2) + ']');

  // Bounded, so an endless chain cannot run away into a squeak.
  const huge = pick(makeSfxState(), fakeGame({ lastClear: clear({ lines: 1, combo: 500 }) }), null);
  ok(huge.rate < 1.5, 'and the pitch is bounded  [' + huge.rate.toFixed(2) + ']');

  // A lock gets heavier as the game speeds up rather than higher.
  const slowLock = pick(makeSfxState(), fakeGame({ level: 1, lastClear: clear({ lines: 0 }) }), null);
  const fastLock = pick(makeSfxState(), fakeGame({ level: 15, lastClear: clear({ lines: 0 }) }), null);
  ok(fastLock.rate < slowLock.rate, 'a lock at a higher level sounds lower');
}

{
  // The actions, in the order they are consulted. A hard drop outranks a plain
  // lock because it is the more informative of the two impacts.
  const sfx = makeSfxState();
  const g = fakeGame({});
  const it = makeIntent();
  it.didRotate = true;
  eq(pick(sfx, g, it).name, SFX.ROTATE, 'a rotate sounds like a rotate');

  it.didHold = true;
  eq(pick(sfx, g, it).name, SFX.HOLD, 'and a hold outranks it');

  it.didHardDrop = true;
  eq(pick(sfx, g, it).name, SFX.HARD_DROP, 'and a hard drop outranks both');
}

{
  // Nothing happened: no sound. A tick with no event must be silent, or the game
  // would drone.
  const sfx = makeSfxState();
  eq(pick(sfx, fakeGame({}), null), null, 'a quiet tick makes no sound');
  eq(pick(sfx, fakeGame({}), makeIntent()), null, 'even with an empty intent');
}

/* --------------------------------------------------------------- level up */

group('level up');

{
  // Gated on the line count as well as the level. `setStartLevel` moves
  // `game.level` from outside a tick — `applyLive` calls it on every settings
  // change — so the level alone would fire a level-up when the player drags the
  // Start-level slider, or starts a new game at a different speed.
  const sfx = makeSfxState();
  pick(sfx, fakeGame({ level: 1, lines: 0 }), null);           // prime

  const fromClear = pick(sfx, fakeGame({ level: 2, lines: 10 }), null);
  eq(fromClear && fromClear.name, SFX.LEVEL_UP, 'a level earned by clearing lines sounds');

  const sfx2 = makeSfxState();
  pick(sfx2, fakeGame({ level: 1, lines: 0 }), null);
  eq(pick(sfx2, fakeGame({ level: 8, lines: 0 }), null), null,
    'but the Start-level slider moving the level makes no sound');
}

/* ------------------------------------------------------------------- over */

group('the end of a run');

{
  const sfx = makeSfxState();
  pick(sfx, fakeGame({ status: STATUS.FALLING }), null);
  const d = pick(sfx, fakeGame({ status: STATUS.OVER }), null);
  eq(d && d.name, SFX.OVER, 'the transition to over sounds');
  eq(d.cut, true, 'and asks for everything playing to be cut first');
  eq(pick(sfx, fakeGame({ status: STATUS.OVER }), null), null,
    'while a later tick in the same state is silent');
}

/* ---------------------------------------------------------------- adapter */

group('the adapter');

{
  // The bridge is injected, so the adapter is testable with fakes — and it must
  // never throw into the frame loop.
  const calls = [];
  const errors = [];
  const bridge = {
    load: async (entries) => {
      calls.push('load:' + entries.length);
      return { loaded: entries.length, total: entries.length, failed: null };
    },
    play: async (name, opts) => { calls.push('play:' + name + ':' + opts.rate); return { id: 1 }; },
    master: async (v) => { calls.push('master:' + v); },
    stopAll: async () => { calls.push('stopAll'); },
    onError: (m) => { errors.push(m); },
  };
  const s = makeSfx(bridge);

  eq(s.isReady(), false, 'not ready before the bank loads');
  const okLoad = await s.loadBank([
    { name: 'lock', bytesB64: 'x' },
    { name: 'clear', bytesB64: 'y' },
  ]);
  eq(okLoad, true, 'a clean load reports success');
  eq(s.isReady(), true, 'and the adapter becomes ready');
  eq(calls[0], 'load:2', 'the whole bank goes over in one call, not one per effect');

  s.fire({ name: SFX.LOCK, rate: 1, cut: false });
  ok(calls.includes('play:lock:1'), 'firing plays the named effect');

  s.fire(null);
  eq(calls.filter((c) => c.startsWith('play:')).length, 1, 'and firing null plays nothing');

  s.fire({ name: SFX.OVER, rate: 1, cut: true });
  ok(calls.includes('stopAll'), 'a cut decision stops everything first');
  eq(calls.indexOf('stopAll') < calls.lastIndexOf('play:over:1'), true,
    'and does so before the new sound, not after');

  s.setVolume(0.5);
  ok(calls.includes('master:0.5'), 'volume goes through the mixer master');
  s.setMuted(true);
  ok(calls.includes('master:0'), 'and muting takes it to zero');
  s.setMuted(false);
  ok(calls.includes('master:0.5'), 'restoring unmutes to the remembered volume');

  // A failed play must be reported, not thrown: `play` is called from the frame
  // loop and a rejected promise there would surface as an unhandled rejection.
  const bad = makeSfx({
    load: async (e) => ({ loaded: e.length, total: e.length, failed: null }),
    play: async () => { throw new Error('denied'); },
    master: async () => {}, stopAll: async () => {}, onError: (m) => errors.push(m),
  });
  await bad.loadBank([{ name: 'lock', bytesB64: 'x' }]);
  bad.fire({ name: SFX.LOCK, rate: 1, cut: false });
  await new Promise((r) => setTimeout(r, 0));
  ok(errors.some((m) => /denied/.test(m)), 'a refused play is reported rather than thrown');
}

{
  // A bank that will not load must not stop the game. The sounds are simply
  // absent — which is a far better outcome than refusing to boot.
  const errors = [];
  const s = makeSfx({
    load: async () => { throw new Error('no sampler'); },
    play: async () => {}, master: async () => {}, stopAll: async () => {},
    onError: (m) => errors.push(m),
  });
  const okLoad = await s.loadBank([{ name: 'lock', bytesB64: 'x' }]);
  eq(okLoad, false, 'a failed load reports failure');
  eq(s.isReady(), false, 'and the adapter stays unready');
  ok(errors.length > 0, 'and the reason is reported');
  s.fire({ name: SFX.LOCK, rate: 1, cut: false });
  eq(errors.length, 1, 'so firing afterwards is a no-op rather than an error storm');
}

{
  // A partial bank must not count as ready. Half a bank would play some events
  // and silently drop others, which is worse than no sound at all: silence is
  // obviously broken, a missing clear sound just looks like the game not
  // noticing.
  const errors = [];
  const s = makeSfx({
    load: async () => ({ loaded: 1, total: 2, failed: 'clear (decode failed)' }),
    play: async () => {}, master: async () => {}, stopAll: async () => {},
    onError: (m) => errors.push(m),
  });
  const okLoad = await s.loadBank([
    { name: 'lock', bytesB64: 'x' },
    { name: 'clear', bytesB64: 'y' },
  ]);
  eq(okLoad, false, 'one bad effect makes the whole bank unready');
  eq(s.isReady(), false, 'and nothing will play');
  ok(errors.some((m) => /clear/.test(m)), 'while the offending effect is named  [' + errors[0] + ']');
}

/* ------------------------------------------------------------------- misc */

group('the menu sound');

{
  const d = uiSound();
  eq(d.name, SFX.UI, 'the UI tick has its own name');
  ok(SFX_NAMES.includes(d.name), 'which the bank can render');
  eq(d.cut, false, 'and it cuts nothing');
}

done('sfx');
