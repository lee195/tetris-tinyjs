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

/**
 * Line-clear delay and ARE (the appearance delay before the next piece), in
 * ticks.
 *
 * **Both default to 0, and that is a correction.** They started at 20 and 10 —
 * classic console-Tetris values — which cost **200 ms of dead time after every
 * placement and 550 ms after a line clear**, during which input does nothing at
 * all. That is not a subtle tuning preference; it is the largest single
 * contributor to how responsive the game feels, and it reads as input delay
 * because it *is* input delay. It was measured, not guessed: see the
 * `dead time after a lock` test.
 *
 * At 0 the next piece is active on the tick after the lock, which is the
 * minimum possible — the lock and the spawn cannot share a tick.
 *
 * Kept configurable rather than hardcoded because legibility is a real
 * preference: raising `lineClearDelay` makes a clear read as a beat instead of
 * a jump, and some players want that. See `setTiming()` in game.js.
 */
export const LINE_CLEAR_DELAY_DEFAULT = 0;
export const ARE_DEFAULT = 0;

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
 * Rotation with SRS kicks. Returns {rot, x, y, kick} or null when every offset
 * is blocked. O has no kick table — its shape is rotation-invariant, so the
 * position is unchanged and `kick` is 0.
 *
 * `kick` is the index of the offset that succeeded, which scoring needs: SRS's
 * fifth offset is the big one, and using it promotes a mini T-spin to a full
 * one regardless of what the corners say.
 */
export function tryRotate(board, piece, rot, x, y, dir) {
  const to = rotateIndex(rot, dir);
  const table = kicksFor(piece);

  if (!table) {
    const shape = SHAPES[piece][to];
    return collides(board, shape, x, y) ? null : { rot: to, x, y, kick: 0 };
  }

  const kicks = table[rot + '>' + to];
  const shape = SHAPES[piece][to];
  for (let i = 0; i < kicks.length; i += 2) {
    const nx = x + kicks[i];
    const ny = y + kicks[i + 1];
    if (!collides(board, shape, nx, ny)) return { rot: to, x: nx, y: ny, kick: i / 2 };
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

/* ------------------------------------------------------------------ t-spins */

/** Result of the T-spin test. */
export const TSPIN = { NONE: 0, MINI: 1, FULL: 2 };

/**
 * The two corners of the T's 3x3 box that the nub points *towards*, per rotation
 * state. Filled front corners are what make a T-spin a full one rather than a
 * mini.
 *
 * The T's rotation centre is the middle of its box, so the box corners are the
 * cells that decide whether it is wedged into a slot. The T never occupies a
 * corner itself, which is why this test can run before or after placement.
 */
const T_FRONT = [
  [[0, 0], [2, 0]],   // rot 0, nub up
  [[2, 0], [2, 2]],   // rot 1, nub right
  [[0, 2], [2, 2]],   // rot 2, nub down
  [[0, 0], [0, 2]],   // rot 3, nub left
];

/** The two corners behind the nub — the same box, the other diagonal. */
const T_BACK = [
  [[0, 2], [2, 2]],
  [[0, 0], [0, 2]],
  [[0, 0], [2, 0]],
  [[2, 0], [2, 2]],
];

/** Is this cell blocking? Walls and the floor count; open sky above does not. */
function solid(board, x, y) {
  if (x < 0 || x >= COLS || y >= TOTAL_ROWS) return true;
  if (y < 0) return false;
  return (board.rows[y] & (1 << x)) !== 0;
}

/**
 * Is the T at this position in a T-spin?
 *
 * The guideline rule: at least three of the four corners of the T's box must be
 * blocked. If both *front* corners are blocked it is a full T-spin; if only one
 * is, it is a mini — **unless** the rotation used SRS's fifth offset, which
 * always counts as full. That exception exists because the fifth offset is the
 * big displacement, and the piece could only have got there by being wedged.
 *
 * The caller is responsible for the other two conditions: the piece must be a T,
 * and the last successful action must have been a rotation rather than a move.
 */
export function detectTSpin(board, rot, x, y, kick) {
  const front = T_FRONT[rot];
  const back = T_BACK[rot];

  let occupied = 0;
  let frontCount = 0;
  for (let i = 0; i < 2; i++) {
    if (solid(board, x + front[i][0], y + front[i][1])) { occupied++; frontCount++; }
  }
  for (let i = 0; i < 2; i++) {
    if (solid(board, x + back[i][0], y + back[i][1])) occupied++;
  }

  if (occupied < 3) return TSPIN.NONE;
  if (frontCount === 2) return TSPIN.FULL;
  return kick === 4 ? TSPIN.FULL : TSPIN.MINI;
}

export { COLS, TOTAL_ROWS };
