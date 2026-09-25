/**
 * Guideline scoring.
 *
 * Pure functions over (what cleared, at what level, with what history). Nothing
 * here touches the board or the game state — `game.js` decides *what* happened
 * and this decides what it is worth, which keeps the tables readable and the
 * arithmetic testable without a board.
 *
 * The two mechanics worth understanding before reading the tables:
 *
 *  - **Back-to-back.** A *difficult* clear — a Tetris, or a full T-spin — keeps
 *    a chain alive. Chaining two of them multiplies the line-clear points by
 *    1.5. Only an actual line clear can start, sustain or break the chain; a
 *    T-spin that clears nothing leaves it alone.
 *  - **Combo.** The counter starts at −1 and increments on every clear, so the
 *    first clear of a chain is combo 0 and earns nothing extra. A lock that
 *    clears nothing resets it. This is why the counter is −1 and not 0: it
 *    makes "how many consecutive clears" fall out of the value itself.
 */

import { TSPIN } from './rules.js';

export { TSPIN };

/** Indexed by lines cleared. */
const LINE_POINTS = [0, 100, 300, 500, 800];
/** Full T-spins, indexed by lines cleared (0 lines is worth 400). */
const TSPIN_POINTS = [400, 800, 1200, 1600];
/** Mini T-spins, indexed by lines cleared (there is no mini triple). */
const TSPIN_MINI_POINTS = [100, 200, 400];
/** Perfect-clear bonus, indexed by lines cleared. */
const PERFECT_POINTS = [0, 800, 1200, 1800, 2000];

/** Points per cell dropped by the player, rather than by gravity. */
export const SOFT_DROP_POINTS = 1;
export const HARD_DROP_POINTS = 2;

/** The back-to-back multiplier, applied to the line-clear points only. */
export const B2B_MULTIPLIER = 1.5;

/** Points per combo step, before the level multiplier. */
export const COMBO_POINTS = 50;

/** A clear that keeps a back-to-back chain alive. */
export function isDifficult(tspin, lines) {
  return tspin === TSPIN.FULL || lines === 4;
}

/** The base value of a clear, before level, back-to-back, combo and perfect. */
export function basePoints(tspin, lines) {
  if (tspin === TSPIN.FULL) return TSPIN_POINTS[lines] || 0;
  if (tspin === TSPIN.MINI) return TSPIN_MINI_POINTS[lines] || 0;
  return LINE_POINTS[lines] || 0;
}

const LINE_LABELS = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'TETRIS'];

/** A short label for the HUD, e.g. "T-SPIN DOUBLE". */
export function clearLabel(tspin, lines) {
  if (tspin === TSPIN.FULL) {
    return lines > 0 ? 'T-SPIN ' + LINE_LABELS[lines] : 'T-SPIN';
  }
  if (tspin === TSPIN.MINI) {
    return lines > 0 ? 'T-SPIN MINI ' + LINE_LABELS[lines] : 'T-SPIN MINI';
  }
  return LINE_LABELS[lines] || '';
}

/**
 * Score one lock.
 *
 * `opts`:
 *   lines         how many rows cleared (0 for a T-spin that cleared nothing)
 *   tspin         TSPIN.NONE | MINI | FULL
 *   level         the level *at the time of the lock*, before any level-up
 *   combo         the combo counter going in (−1 for none)
 *   backToBack    whether a difficult clear is currently chained
 *   perfect       whether the clear emptied the board
 *
 * Returns a fresh object; nothing is mutated. `points` is what to add to the
 * score, and `combo`/`backToBack` are the state to carry into the next lock.
 */
export function scoreClear(opts) {
  const lines = opts.lines | 0;
  const tspin = opts.tspin | 0;
  const level = opts.level || 1;
  const comboBefore = opts.combo === undefined ? -1 : opts.combo;
  const b2bBefore = !!opts.backToBack;

  const base = basePoints(tspin, lines);
  let points = base * level;
  let combo;
  let backToBack;
  let difficult = false;
  let b2bApplied = false;

  if (lines > 0) {
    difficult = isDifficult(tspin, lines);
    // Back-to-back multiplies the line-clear points, and only when the chain was
    // already alive — the first difficult clear of a chain earns no bonus.
    if (difficult && b2bBefore) {
      points = Math.floor(points * B2B_MULTIPLIER);
      b2bApplied = true;
    }
    backToBack = difficult;

    combo = comboBefore + 1;
    if (combo > 0) points += COMBO_POINTS * combo * level;

    if (opts.perfect) points += (PERFECT_POINTS[lines] || 0) * level;
  } else {
    // No line clear: the combo breaks, but a T-spin with no lines still scores
    // (400 full / 100 mini) and the back-to-back chain is left untouched.
    combo = -1;
    backToBack = b2bBefore;
  }

  return {
    points,
    combo,
    backToBack,
    difficult,
    b2bApplied,
    label: clearLabel(tspin, lines),
    lines,
    tspin,
  };
}

/** Points for a player-driven drop. Gravity earns nothing. */
export function dropPoints(cells, hard) {
  return cells * (hard ? HARD_DROP_POINTS : SOFT_DROP_POINTS);
}
