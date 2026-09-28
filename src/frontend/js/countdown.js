/**
 * The pre-run countdown: a driver-side delay before the first tick.
 *
 * Deliberately **not** part of the simulation. A countdown inside `game` would
 * change `game.ticks`, and the tick count is hashed by the replay tests and
 * recorded in every replay header — so the day it shipped, every replay recorded
 * before it would stop reproducing and the seed-plus-log contract would gain a
 * field that is pure presentation. Keeping it here means the simulation, the
 * replay format and `gameHash` are untouched.
 *
 * Counted in ticks, not milliseconds, so it runs on the same fixed timestep as
 * the game and cannot drift with the frame rate. The driver feeds it the ticks
 * `advance()` produced, and spends whatever is left over on the simulation — see
 * `advanceCountdown`.
 *
 * Pure — no DOM, no `tiny`, no clock — so Node can test it.
 */

import { TICK_HZ } from './constants.js';

/** How long the run is held before the first piece appears. */
export const COUNTDOWN_SECONDS = 3;

/** How long "GO!" stays up once the countdown ends, in ticks. */
export const GO_TICKS = 30;

export function makeCountdown() {
  return { ticks: 0, go: 0 };
}

/**
 * Begin a countdown of `seconds`. Zero (or anything non-positive) disables it,
 * which is the shape a future setting would want without a second code path.
 */
export function startCountdown(c, seconds) {
  const s = Number(seconds);
  c.ticks = Number.isFinite(s) && s > 0 ? Math.round(s * TICK_HZ) : 0;
  c.go = 0;
}

/** End it early, as a keypress does, while still flashing "GO!". */
export function skipCountdown(c) {
  if (c.ticks > 0) {
    c.ticks = 0;
    c.go = GO_TICKS;
  }
}

export function isCountingDown(c) {
  return c.ticks > 0;
}

/**
 * Consume `n` ticks of the countdown and return how many are **left over**.
 *
 * The leftover is the point: a frame can straddle the end of the countdown, and
 * dropping the remainder would lose a fraction of a tick every time the window
 * happens to line up badly. The driver spends the leftover on the simulation.
 */
export function advanceCountdown(c, n) {
  if (c.ticks <= 0) return n;
  const used = Math.min(c.ticks, n);
  c.ticks -= used;
  if (c.ticks === 0) c.go = GO_TICKS;
  return n - used;
}

/** Decay the "GO!" window during normal play. */
export function fadeCountdown(c, n) {
  if (c.go > 0) c.go = Math.max(0, c.go - n);
}

/**
 * What to show, or '' for nothing.
 *
 * The number is `ceil`, so a 3-second countdown reads 3, 2, 1 and then GO — never
 * 0, which would be a fifth of a second of dead air.
 */
export function countdownLabel(c) {
  if (c.ticks > 0) return String(Math.ceil(c.ticks / TICK_HZ));
  if (c.go > 0) return 'GO';
  return '';
}
