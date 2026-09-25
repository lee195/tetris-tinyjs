/**
 * Movement, rotation and placement rules.
 *
 * "What moves are legal" — pure predicates over (board, piece, position). The
 * *when* (timers, lock delay, gravity) lives in game.js. Nothing here mutates
 * the board.
 *
 * Pure — no DOM, no `tiny` — so Node can test it.
 */

import { COLS, TOTAL_ROWS, SPAWN_X } from './constants.js';
import { SHAPES, BOUNDS, SPAWN_Y, kicksFor, rotateIndex } from './pieces.js';
import { collides } from './board.js';

/* ------------------------------------------------------------------ timing */

/** Frames a grounded piece waits before locking. 30 @ 60Hz = 500ms. */
export const LOCK_DELAY = 30;

/**
 * How many times a move/rotation may restart the lock timer before it is spent.
 * Without a cap, "infinity" lets a player stall forever; the Guideline's
 * practical form is a reset budget.
 */
export const MOVE_RESET_LIMIT = 15;
export const ROTATE_RESET_LIMIT = 15;

/**
 * When true, move- and rotate-resets draw from ONE shared budget instead of two
 * (NullpoMino's `lockresetLimitShareCount`). Separate budgets are the Guideline
 * norm.
 */
export const SHARE_RESET_BUDGET = false;

/** Frames of line-clear delay and spawn delay (ARE). */
export const LINE_CLEAR_DELAY = 20;
export const SPAWN_DELAY = 10;

/**
 * Guideline gravity: seconds-per-cell is (0.8 - (level-1)*0.007)^(level-1).
 * Returned as whole frames, floored at 1 — a piece never falls more than one
 * cell per tick, which is what keeps hard-drop and gravity distinct.
 */
export function gravityFrames(level) {
  const l = Math.max(1, level | 0);
  const secs = Math.pow(0.8 - (l - 1) * 0.007, l - 1);
  return Math.max(1, Math.round(secs * 60));
}

/* ---------------------------------------------------------------- movement */

/** Offset of a legal move, or null. */
export function tryMove(board, piece, rot, x, y, dx, dy) {
  const shape = SHAPES[piece][rot];
  if (collides(board, shape, x + dx, y + dy)) return null;
  return { x: x + dx, y: y + dy };
}

/** Where the piece lands if dropped straight down, as an absolute row. */
export function dropRow(board, piece, rot, x, y) {
  const shape = SHAPES[piece][rot];
  let drop = Infinity;
  for (let i = 0; i < shape.length; i += 2) {
    const cx = x + shape[i];
    const cy = y + shape[i + 1];
    // top[cx] is the highest filled row in that column, or TOTAL_ROWS if empty.
    const d = board.top[cx] - 1 - cy;
    if (d < drop) drop = d;
  }
  return y + (drop === Infinity ? 0 : drop);
}

/**
 * Rotation with SRS kicks. Returns {rot, x, y} or null when every offset is
 * blocked. O has no kick table — its shape is rotation-invariant, so the
 * position is unchanged.
 */
export function tryRotate(board, piece, rot, x, y, dir) {
  const to = rotateIndex(rot, dir);
  const table = kicksFor(piece);

  if (!table) {
    const shape = SHAPES[piece][to];
    return collides(board, shape, x, y) ? null : { rot: to, x, y };
  }

  const kicks = table[rot + '>' + to];
  const shape = SHAPES[piece][to];
  for (let i = 0; i < kicks.length; i += 2) {
    const nx = x + kicks[i];
    const ny = y + kicks[i + 1];
    if (!collides(board, shape, nx, ny)) return { rot: to, x: nx, y: ny };
  }
  return null;
}

/* ------------------------------------------------------------------- spawn */

/**
 * Spawn position for a piece: box left edge at SPAWN_X, and the topmost
 * occupied cell on the first visible row (derived per piece, because the
 * bounding boxes differ in height).
 */
export function spawnPosition(piece) {
  return { x: SPAWN_X, y: SPAWN_Y[piece], rot: 0 };
}

/** True when a freshly spawned piece has nowhere to go — the top-out test. */
export function isBlockedOut(board, piece, x, y, rot) {
  return collides(board, SHAPES[piece][rot], x, y);
}

/** Horizontal bounds of a shape at a position, for wall-clamp helpers. */
export function shapeBounds(piece, rot) {
  return BOUNDS[piece][rot];
}

export { COLS, TOTAL_ROWS };
