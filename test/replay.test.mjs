/**
 * Headless tests for replay record and playback.
 *
 *   node test/replay.test.mjs
 *
 * The round-trip is the strongest single test of the whole simulation: record a
 * real run, feed the log back through the same code, and require the final state
 * hash, score, line count and tick count to match exactly. Everything the sim
 * reads that it should not — a clock, a random source, an unrecorded input path
 * — shows up here as a divergence, and nothing else catches those as directly.
 *
 * The rest of the file covers the encoding, because a replay bug is invisible:
 * a log that decodes to a *slightly* different frame sequence produces a
 * plausible game that is simply not the one that was played.
 */

import { makeGame, gameHash, STATUS } from '../src/frontend/js/game.js';
import { makeHandling, makeInputFrame } from '../src/frontend/js/handling.js';
import { stepWithInput } from '../src/frontend/js/apply.js';
import { makeRng } from '../src/frontend/js/rng.js';
import {
  REPLAY_VERSION, packFrame, unpackFrame, makeRecorder, recordTick,
  finishRecording, makePlayer, nextFrame, logTicks, buildReplay,
  handlingFromReplay, startPlayback, playbackStep, verifyReplay,
  serializeReplay, deserializeReplay,
} from '../src/frontend/js/replay.js';
import { ok, eq, group, done } from './harness.mjs';

/* ---------------------------------------------------------------- helpers */

function throws(fn) {
  try { fn(); return false; } catch (err) { return true; }
}

/**
 * A scripted input source with realistic edges, driven by its own RNG so the
 * script is identical across runs regardless of the game seed.
 *
 * Deliberately **bursty**: a direction is held for a run of ticks and one-shots
 * are sparse. An earlier version drew an independent coin flip per tick, which
 * meant a rotation fired on ~5% of all ticks — 3 presses a second, which no
 * player does. It made the run-length encoding look useless, and the compression
 * assertion caught it.
 */
function makeScript(seed) {
  const rnd = makeRng(seed);
  let held = 0;
  let holdLeft = 0;
  let soft = false;
  let cooldown = 0;
  let prevLeft = false;
  let prevRight = false;

  return function scripted(f) {
    if (holdLeft <= 0) {
      const r = rnd();
      held = r < 0.35 ? -1 : (r < 0.7 ? 1 : 0);
      holdLeft = 8 + Math.floor(rnd() * 30);
      soft = rnd() < 0.25;
    }
    holdLeft--;

    f.left = held === -1;
    f.right = held === 1;
    f.leftEdge = f.left && !prevLeft;
    f.rightEdge = f.right && !prevRight;
    f.softDrop = soft;
    prevLeft = f.left;
    prevRight = f.right;

    f.cwEdge = false;
    f.ccwEdge = false;
    f.hardEdge = false;
    f.holdEdge = false;
    if (cooldown <= 0) {
      const r = rnd();
      if (r < 0.5) f.cwEdge = true;
      else if (r < 0.68) f.ccwEdge = true;
      else if (r < 0.85) f.holdEdge = true;
      else f.hardEdge = true;
      cooldown = 15 + Math.floor(rnd() * 45);
    }
    cooldown--;
    return f;
  };
}

/**
 * Drive a run the way the driver does, recording every tick.
 *
 * `ticksPerFrame` above 1 reproduces a catch-up frame, where the keyboard is
 * polled once but the simulation advances several ticks. That case is the whole
 * reason the log is per tick: the second tick of such a frame sees the edges
 * already consumed, and recording frames instead would lose that.
 */
function driveRun(opts) {
  const game = makeGame({ seed: opts.seed, mode: opts.mode });
  const handling = makeHandling(opts.handlingCfg);
  const frame = makeInputFrame();
  const rec = makeRecorder();
  const script = makeScript(0xfeed);
  const perFrame = opts.ticksPerFrame || 1;

  for (let i = 0; i < opts.frames; i++) {
    if (game.status === STATUS.OVER) break;
    script(frame);
    for (let k = 0; k < perFrame; k++) {
      recordTick(rec, frame);          // before the tick consumes the edges
      stepWithInput(game, handling, frame);
      if (game.status === STATUS.OVER) break;
    }
  }
  finishRecording(rec);
  return { game, handling, rec };
}

const CFG = { das: 6, arr: 2, sdf: 4, dcd: 2 };

/* --------------------------------------------------------------- encoding */

group('frame packing');

{
  // Exhaustive over all 9 bits: a single wrong mask would otherwise pass a
  // hand-picked sample.
  const a = makeInputFrame();
  const b = makeInputFrame();
  let allOk = true;
  for (let code = 0; code < 512; code++) {
    unpackFrame(code, a);
    if (packFrame(a) !== code) allOk = false;
    unpackFrame(code, b);
    if (packFrame(b) !== code) allOk = false;
  }
  ok(allOk, 'every one of the 512 codes round-trips through pack/unpack');

  const f = makeInputFrame();
  f.left = true; f.hardEdge = true;
  const g = unpackFrame(packFrame(f), makeInputFrame());
  ok(g.left && g.hardEdge, 'a real frame survives the round trip');
  ok(!g.right && !g.softDrop && !g.cwEdge, 'and the unset bits stay unset');
}

group('run-length encoding');

{
  const rec = makeRecorder();
  const f = makeInputFrame();
  for (let i = 0; i < 500; i++) recordTick(rec, f);
  finishRecording(rec);

  eq(rec.pairs.length, 2, '500 identical ticks collapse to a single pair');
  eq(rec.pairs[0], 500, 'with the right run length');
  eq(rec.pairs[1], 0, 'and code 0 for nothing held');
  eq(logTicks(rec.pairs), 500, 'logTicks counts the ticks back');

  // Alternating frames cannot be compressed, and must not be lost.
  const rec2 = makeRecorder();
  const g = makeInputFrame();
  for (let i = 0; i < 10; i++) {
    g.left = i % 2 === 0;
    recordTick(rec2, g);
  }
  finishRecording(rec2);
  eq(rec2.pairs.length, 20, 'alternating frames become one pair each');
  eq(logTicks(rec2.pairs), 10, 'and still describe ten ticks');
}

{
  // finishRecording must be safe to call twice — buildReplay may be reached
  // from more than one path.
  const rec = makeRecorder();
  recordTick(rec, makeInputFrame());
  const first = finishRecording(rec).length;
  const second = finishRecording(rec).length;
  eq(first, second, 'finishRecording is idempotent');
}

group('playback reconstructs the recorded frames');

{
  const rec = makeRecorder();
  const f = makeInputFrame();
  const codes = [];
  for (let i = 0; i < 30; i++) {
    f.left = i % 3 === 0;
    f.right = i % 5 === 0;
    f.rightEdge = i === 7;
    f.hardEdge = i === 13;
    f.holdEdge = i === 22;
    codes.push(packFrame(f));
    recordTick(rec, f);
  }
  finishRecording(rec);

  const player = makePlayer(rec.pairs);
  const out = makeInputFrame();
  let same = true;
  for (let i = 0; i < 30; i++) {
    if (!nextFrame(player, out)) { same = false; break; }
    if (packFrame(out) !== codes[i]) same = false;
  }
  ok(same, 'every recorded frame comes back identical, in order');
  ok(!nextFrame(player, out), 'and the log ends exactly when the ticks do');
}

/* ----------------------------------------------------------- the round trip */

group('replay round trip (the whole simulation)');

{
  const run = driveRun({
    seed: 1234, mode: 'marathon', handlingCfg: CFG, frames: 1500, ticksPerFrame: 1,
  });
  ok(run.game.pieces > 5, 'the scripted run actually played several pieces');
  ok(run.game.score > 0, 'and scored something');

  const replay = buildReplay(run.game, run.handling.cfg, run.rec.pairs);
  const v = verifyReplay(replay);

  ok(v.ok, 'the replay reproduces the run exactly');
  eq(v.actual, v.expected, 'and the hashes match');
  eq(v.score, run.game.score, 'the score matches');
  eq(v.lines, run.game.lines, 'the line count matches');
  eq(v.pieces, run.game.pieces, 'the piece count matches');
  eq(v.ticks, run.game.ticks, 'the tick count matches');
  eq(replay.ticks, run.game.ticks, 'and the replay recorded every tick');
}

{
  // A catch-up frame: the keyboard is polled once but two ticks run. The second
  // tick must see the edges already consumed, and the log has to capture that.
  const run = driveRun({
    seed: 77, mode: 'marathon', handlingCfg: CFG, frames: 900, ticksPerFrame: 2,
  });
  const replay = buildReplay(run.game, run.handling.cfg, run.rec.pairs);
  ok(verifyReplay(replay).ok,
    'a run with two ticks per frame reproduces (the reason the log is per tick)');
}

{
  const run = driveRun({
    seed: 9, mode: 'sprint', handlingCfg: { das: 0, arr: 0, sdf: Infinity, dcd: 0 },
    frames: 1200, ticksPerFrame: 1,
  });
  const replay = buildReplay(run.game, run.handling.cfg, run.rec.pairs);
  ok(verifyReplay(replay).ok, 'an instant-ARR run reproduces too');

  // The config is genuinely part of the replay, not decoration.
  const tampered = JSON.parse(serializeReplay(replay));
  tampered.cfg.handling.das = 30;
  ok(!verifyReplay(tampered).ok, 'changing DAS breaks the replay');

  const reseeded = JSON.parse(serializeReplay(replay));
  reseeded.seed = replay.seed + 1;
  ok(!verifyReplay(reseeded).ok, 'changing the seed breaks the replay');

  const retimed = JSON.parse(serializeReplay(replay));
  retimed.cfg.are = 20;
  ok(!verifyReplay(retimed).ok, 'changing the ARE breaks the replay');
}

{
  // Both cases below need a run that genuinely *ended*. With a game still in
  // progress, extra log entries change the outcome — and correctly so — so the
  // "ignored" property only holds once the game is over and playback stops at
  // the ending rather than at the end of the log.
  const run = driveRun({
    seed: 31, mode: 'ultra', handlingCfg: CFG, frames: 7600, ticksPerFrame: 1,
  });
  eq(run.game.status, STATUS.OVER, 'the run ended');
  const replay = buildReplay(run.game, run.handling.cfg, run.rec.pairs);
  ok(verifyReplay(replay).ok, 'and reproduces');

  const cut = JSON.parse(serializeReplay(replay));
  cut.log = cut.log.slice(0, 2);
  const v = verifyReplay(cut);
  ok(!v.ok, 'a truncated log does not reproduce');
  ok(!v.exhausted, 'and playback terminates rather than running to the bound');

  const extra = JSON.parse(serializeReplay(replay));
  extra.log = extra.log.concat([600, 0]);
  ok(verifyReplay(extra).ok, 'extra log entries past the end are ignored');
}

/* ------------------------------------------------------------ the Infinity trap */

group('config encoding');

{
  // JSON has no Infinity and sdf defaults to it, so it is stored as null. Getting
  // this wrong would silently turn instant soft drop into one cell per frame.
  const run = driveRun({
    seed: 4, mode: 'marathon', handlingCfg: { das: 4, arr: 1, sdf: Infinity, dcd: 0 },
    frames: 400, ticksPerFrame: 1,
  });
  const replay = buildReplay(run.game, run.handling.cfg, run.rec.pairs);
  eq(replay.cfg.handling.sdf, null, 'Infinity is stored as null');
  ok(replay.cfg.handling.sdf !== undefined, 'and the key is present');

  const text = serializeReplay(replay);
  const back = deserializeReplay(text);
  eq(handlingFromReplay(back).sdf, Infinity, 'and decodes back to Infinity');
  ok(verifyReplay(back).ok, 'so an instant-SDF replay reproduces');

  eq(handlingFromReplay({ cfg: { handling: { sdf: 3 } } }).sdf, 3,
    'a finite sdf is left alone');
}

/* ------------------------------------------------------------- persistence */

group('serialization');

{
  // Enough frames to run out Ultra's tick budget, so the run definitely ends and
  // `result` is populated. The ending has to survive serialization — it is what
  // a high-score table would show.
  const run = driveRun({
    seed: 55, mode: 'ultra', handlingCfg: CFG, frames: 7600, ticksPerFrame: 1,
  });
  eq(run.game.status, STATUS.OVER, 'the run ended');
  ok(run.game.result, 'with a result to record');

  const replay = buildReplay(run.game, run.handling.cfg, run.rec.pairs);
  const text = serializeReplay(replay);
  ok(typeof text === 'string' && text.length > 0, 'a replay serializes to text');

  const back = deserializeReplay(text);
  eq(back.seed, replay.seed, 'the seed survives');
  eq(back.mode, replay.mode, 'the mode survives');
  eq(back.hash, replay.hash, 'the verification hash survives');
  eq(back.v, REPLAY_VERSION, 'and the format version is stamped');
  eq(back.result.score, replay.result.score, 'the recorded result survives');
  eq(back.result.reason, replay.result.reason, 'including the ending reason');
  ok(verifyReplay(back).ok, 'and a round-tripped replay still reproduces');

  // Strict parsing: a malformed log fed to the simulation would produce a
  // plausible wrong game rather than an error, so it is rejected up front.
  const base = { v: REPLAY_VERSION, seed: 1, cfg: { handling: {} }, log: [] };
  ok(throws(() => deserializeReplay('{')), 'invalid JSON is rejected');
  ok(throws(() => deserializeReplay('null')), 'null is rejected');
  ok(throws(() => deserializeReplay('{}')), 'a missing version is rejected');
  ok(throws(() => deserializeReplay(JSON.stringify(
    Object.assign({}, base, { v: 99 })))), 'a different format version is rejected');
  ok(throws(() => deserializeReplay(JSON.stringify(
    Object.assign({}, base, { seed: undefined })))), 'a missing seed is rejected');
  ok(throws(() => deserializeReplay(JSON.stringify(
    Object.assign({}, base, { cfg: null })))), 'a missing config is rejected');
  ok(throws(() => deserializeReplay(JSON.stringify(
    Object.assign({}, base, { log: [1] })))), 'an odd-length log is rejected');
  ok(throws(() => deserializeReplay(JSON.stringify(
    Object.assign({}, base, { log: [0, 0] })))), 'a zero-length run is rejected');
  ok(throws(() => deserializeReplay(JSON.stringify(
    Object.assign({}, base, { log: [1, -5] })))), 'a negative code is rejected');
  ok(throws(() => deserializeReplay(JSON.stringify(
    Object.assign({}, base, { log: 'nope' })))), 'a non-array log is rejected');
  ok(deserializeReplay(JSON.stringify(
    Object.assign({}, base, { log: [2, 0] }))), 'a well-formed one is accepted');
}

{
  // A run that is still going records no result, but its replay still has to
  // verify against the state at the point recording stopped — otherwise an
  // abandoned run could never be checked.
  const run = driveRun({
    seed: 3, mode: 'marathon', handlingCfg: CFG, frames: 200, ticksPerFrame: 1,
  });
  ok(run.game.status !== STATUS.OVER, 'the short run is still going');
  const replay = buildReplay(run.game, run.handling.cfg, run.rec.pairs);
  eq(replay.result, null, 'so it records no result');
  ok(verifyReplay(replay).ok, 'but it still verifies');
}

/* ------------------------------------------------------------- compression */

group('the log stays small');

{
  const run = driveRun({
    seed: 808, mode: 'marathon', handlingCfg: CFG, frames: 3000, ticksPerFrame: 1,
  });
  const replay = buildReplay(run.game, run.handling.cfg, run.rec.pairs);
  const ticks = logTicks(replay.log);
  const ratio = ticks / (replay.log.length / 2);

  eq(ticks, run.game.ticks, 'the log describes every tick of the run');
  ok(replay.log.length / 2 < ticks, 'and uses fewer pairs than ticks');
  ok(ratio > 3, 'run-length encoding is doing real work (' + ratio.toFixed(1) + ' ticks per pair)');
}

/* --------------------------------------------------------------- summary */

done('replay');
