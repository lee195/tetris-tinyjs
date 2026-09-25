/**
 * Fixed-timestep accumulator.
 *
 * The simulation must advance in whole 60Hz ticks regardless of how often the
 * browser paints, so DAS/ARR counters (which are counted in frames) mean the
 * same thing on every machine and in every replay. This is the piece that makes
 * that true.
 *
 * The clamp is the load-bearing part. WebKit starves rAF and stretches timers
 * when a window is occluded, so a stall is normal, not exceptional. Without the
 * clamp a 2-second stall would return 120 ticks and the piece would teleport to
 * the floor. Past MAX_CATCHUP_MS the elapsed time is *dropped*, not simulated —
 * which is the right trade for a game (a missed second is a missed second) and
 * is why the caller should also pause on blur.
 *
 * Pure — no DOM, no `tiny` — so Node can test it.
 */

import { TICK_MS, MAX_CATCHUP_MS } from './constants.js';

export { TICK_MS, MAX_CATCHUP_MS };

export function makeLoop() {
  return {
    acc: 0,          // unspent milliseconds
    ticks: 0,        // total ticks emitted
    frames: 0,       // total advance() calls
    dropped: 0,      // advance() calls that hit the clamp
    maxFrameMs: 0,   // worst frame seen, for the perf harness
  };
}

/**
 * Feed elapsed milliseconds; returns how many fixed ticks to run now.
 * Callers loop `n` times over `step()` and then render once.
 */
export function advance(loop, dtMs) {
  if (!(dtMs > 0)) dtMs = 0; // guards NaN and negative deltas
  if (dtMs > loop.maxFrameMs) loop.maxFrameMs = dtMs;
  loop.frames++;

  if (dtMs > MAX_CATCHUP_MS) {
    loop.dropped++;
    dtMs = MAX_CATCHUP_MS;
  }

  loop.acc += dtMs;
  let n = 0;
  while (loop.acc >= TICK_MS) {
    loop.acc -= TICK_MS;
    n++;
  }
  loop.ticks += n;
  return n;
}

/** Fraction of the way through the next tick — for optional render smoothing. */
export function alpha(loop) {
  return loop.acc / TICK_MS;
}

export function resetLoop(loop) {
  loop.acc = 0;
  loop.ticks = 0;
  loop.frames = 0;
  loop.dropped = 0;
  loop.maxFrameMs = 0;
}
