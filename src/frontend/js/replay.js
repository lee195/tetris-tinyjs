/**
 * Replay: record a run, play it back, and prove it reproduced.
 *
 * A replay is **a seed, a configuration, and a per-tick input log**. Nothing
 * else. The simulation is deterministic, so those three fully determine the run
 * — which is why every module under this one is free of clocks and random
 * sources, and why Phase 2 counted DAS/ARR in whole ticks rather than
 * timestamps. If any of that were untrue, this file could not work.
 *
 * The log is **per tick, not per frame**. The driver polls the keyboard once per
 * rendered frame but may run several ticks in it (catch-up after a stall), and
 * `tick()` consumes the edge latches — so the second tick of a frame genuinely
 * sees different input from the first. Recording frames would lose that and the
 * replay would drift.
 *
 * ## Why the log is frames and not key events
 *
 * A key-event log (`tick, key, down`) would be smaller and nicer to read, but
 * playing it back means reimplementing the adapter's latching and edge
 * semantics — a second implementation that can silently disagree with the first.
 * Recording the frames the simulation actually received has no such failure
 * mode: playback is the same frames, byte for byte.
 *
 * ## Verification
 *
 * `REPLAY_VERSION` covers *format* changes. It deliberately does not try to
 * cover changes to the simulation's behaviour — a rules tweak would need a
 * version bump on every commit, and the bump would be forgotten. Instead the
 * replay carries the final `gameHash`, and `verifyReplay` re-runs the log and
 * compares. A replay that no longer reproduces is *detected* and reported rather
 * than trusted, which is strictly better than a version number nobody maintains.
 *
 * Pure — no DOM, no `tiny` — so Node can test it.
 */

import { makeGame, step, gameHash, setTiming, STATUS } from './game.js';
import { makeHandling, makeInputFrame, encodeHandling, decodeHandling } from './handling.js';
import { stepWithInput } from './apply.js';

/** Bump only when the *encoding* changes, not when the game rules change. */
export const REPLAY_VERSION = 1;

/* ------------------------------------------------------------- frame packing */

/**
 * Pack an input frame into 9 bits.
 *
 * Held state and edges share one code because both are per-tick facts about the
 * frame. A held key that is still down next tick is recorded again, which RLE
 * then collapses to nothing.
 */
export function packFrame(f) {
  return (f.left ? 1 : 0)
    | (f.right ? 2 : 0)
    | (f.softDrop ? 4 : 0)
    | (f.leftEdge ? 8 : 0)
    | (f.rightEdge ? 16 : 0)
    | (f.cwEdge ? 32 : 0)
    | (f.ccwEdge ? 64 : 0)
    | (f.hardEdge ? 128 : 0)
    | (f.holdEdge ? 256 : 0);
}

/** The inverse of `packFrame`, into a caller-owned frame. */
export function unpackFrame(code, f) {
  f.left = (code & 1) !== 0;
  f.right = (code & 2) !== 0;
  f.softDrop = (code & 4) !== 0;
  f.leftEdge = (code & 8) !== 0;
  f.rightEdge = (code & 16) !== 0;
  f.cwEdge = (code & 32) !== 0;
  f.ccwEdge = (code & 64) !== 0;
  f.hardEdge = (code & 128) !== 0;
  f.holdEdge = (code & 256) !== 0;
  return f;
}

/* ------------------------------------------------------------------ recording */

export function makeRecorder() {
  return {
    /** Flat run-length pairs: [count, code, count, code, ...]. */
    pairs: [],
    last: -1,
    run: 0,
    ticks: 0,
  };
}

/**
 * Record one tick's frame. Call this **before** the tick consumes the edges.
 *
 * Run-length encoded as it goes: consecutive identical frames are the norm
 * (holding a direction, or holding nothing at all), so this typically collapses
 * thousands of ticks into a handful of pairs.
 */
export function recordTick(rec, frame) {
  const code = packFrame(frame);
  rec.ticks++;
  if (code === rec.last) { rec.run++; return; }
  if (rec.run > 0) { rec.pairs.push(rec.run, rec.last); }
  rec.last = code;
  rec.run = 1;
}

/** Close the recording and return the flat pair list. Idempotent. */
export function finishRecording(rec) {
  if (rec.run > 0) {
    rec.pairs.push(rec.run, rec.last);
    rec.run = 0;
  }
  return rec.pairs;
}

/* ------------------------------------------------------------------ playback */

export function makePlayer(pairs) {
  return {
    pairs,
    index: 0,
    remaining: 0,
    code: 0,
    frames: 0,
  };
}

/**
 * Write the next tick's frame into `frame`. Returns false when the log runs out.
 *
 * `frame` is caller-owned and reused — nothing here allocates, because this runs
 * inside the tick loop.
 */
export function nextFrame(player, frame) {
  if (player.remaining === 0) {
    if (player.index + 1 >= player.pairs.length) return false;
    player.remaining = player.pairs[player.index];
    player.code = player.pairs[player.index + 1];
    player.index += 2;
  }
  player.remaining--;
  player.frames++;
  unpackFrame(player.code, frame);
  return true;
}

/** How many ticks the log describes. */
export function logTicks(pairs) {
  let n = 0;
  for (let i = 0; i < pairs.length; i += 2) n += pairs[i];
  return n;
}

/* ---------------------------------------------------------------- the replay */

/**
 * Build a replay from a finished run.
 *
 * `handlingCfg` is passed separately because the handling settings live in the
 * handling module, not on the game state — but they change the simulation just
 * as much as the board does, so a replay that omitted them would not reproduce.
 */
export function buildReplay(game, handlingCfg, pairs) {
  return {
    v: REPLAY_VERSION,
    seed: game.seed,
    mode: game.mode.id,
    cfg: {
      are: game.are,
      lineClearDelay: game.lineClearDelay,
      // Through the shared encoder, so `sdf: Infinity` cannot become 1 on the
      // way back out of JSON. See encodeHandling.
      handling: encodeHandling(handlingCfg),
    },
    ticks: game.ticks,
    // Copied field by field rather than spread, so that adding a field to the
    // result is a deliberate act. `ticks` was missing here, which made every
    // saved high-score entry record zero ticks — the backend coerces a
    // non-finite number to 0 rather than rejecting it, so nothing complained.
    result: game.result
      ? {
        reason: game.result.reason,
        lines: game.result.lines,
        score: game.result.score,
        pieces: game.result.pieces,
        level: game.result.level,
        ticks: game.result.ticks,
      }
      : null,
    /** The final state, for verification. */
    hash: gameHash(game),
    log: pairs,
  };
}

/**
 * The high-score entry for a finished run, or null if it never ended.
 *
 * Extracted from the driver so the shape is testable: the backend validates
 * every field of this object, and a field that is the wrong type is a rejected
 * save rather than a wrong number. `date` is passed in rather than read here,
 * because this module must not consult a clock.
 */
export function scoreEntry(replay, date) {
  const r = replay.result;
  if (!r) return null;
  return {
    mode: replay.mode,
    score: r.score,
    lines: r.lines,
    ticks: r.ticks,
    reason: r.reason,
    date: date || 0,
  };
}

/** Undo the `sdf: null` encoding from `buildReplay`. */
export function handlingFromReplay(replay) {
  return decodeHandling(replay.cfg.handling);
}

/**
 * Set up a replay for playback: a fresh game and handling state configured
 * exactly as the recording was.
 */
export function startPlayback(replay) {
  const game = makeGame({ seed: replay.seed, mode: replay.mode });
  setTiming(game, { are: replay.cfg.are, lineClearDelay: replay.cfg.lineClearDelay });
  return {
    game,
    handling: makeHandling(handlingFromReplay(replay)),
    player: makePlayer(replay.log),
    frame: makeInputFrame(),
  };
}

/**
 * Advance playback by one tick. Returns false when it is finished.
 *
 * Stops either when the log runs out or when the game ends — whichever comes
 * first, which is the same tick for a well-formed replay.
 */
export function playbackStep(pb) {
  if (pb.game.status === STATUS.OVER) return false;
  if (!nextFrame(pb.player, pb.frame)) return false;
  stepWithInput(pb.game, pb.handling, pb.frame);
  return true;
}

/**
 * Re-run a replay and report whether it reproduced.
 *
 * Bounded by the log's own length plus a margin: an unbounded loop here would
 * hang on a corrupt replay, which is the one case this function exists to
 * diagnose.
 */
export function verifyReplay(replay) {
  const pb = startPlayback(replay);
  const limit = logTicks(replay.log) + 600;
  let n = 0;
  while (n < limit && playbackStep(pb)) n++;

  const actual = gameHash(pb.game);
  const expected = replay.hash;
  return {
    ok: actual === expected,
    expected,
    actual,
    ticks: pb.game.ticks,
    score: pb.game.score,
    lines: pb.game.lines,
    pieces: pb.game.pieces,
    expectedScore: replay.result ? replay.result.score : 0,
    expectedLines: replay.result ? replay.result.lines : 0,
    exhausted: n >= limit,
  };
}

/* -------------------------------------------------------------- persistence */

/** JSON text for a replay file. */
export function serializeReplay(replay) {
  return JSON.stringify(replay);
}

/**
 * Parse a replay, rejecting anything that is not one.
 *
 * Deliberately strict: a malformed log would otherwise be fed to the simulation
 * and produce a plausible-looking wrong game rather than an error.
 */
export function deserializeReplay(text) {
  const r = typeof text === 'string' ? JSON.parse(text) : text;
  if (!r || typeof r !== 'object') throw new Error('replay: not an object');
  if (r.v !== REPLAY_VERSION) {
    throw new Error('replay: format version ' + r.v + ', expected ' + REPLAY_VERSION);
  }
  if (typeof r.seed !== 'number') throw new Error('replay: missing seed');
  if (!r.cfg || !r.cfg.handling) throw new Error('replay: missing config');
  if (!Array.isArray(r.log) || r.log.length % 2 !== 0) {
    throw new Error('replay: log must be a flat list of [count, code] pairs');
  }
  for (let i = 0; i < r.log.length; i += 2) {
    if (!(r.log[i] > 0) || !(r.log[i + 1] >= 0)) {
      throw new Error('replay: bad run-length pair at ' + i);
    }
  }
  return r;
}
