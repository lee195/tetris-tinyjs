/**
 * The playfield.
 *
 * Each row is a 10-bit mask in a Uint16Array, so the row-full test is a single
 * integer compare (`row === FULL_ROW`) rather than a 10-cell scan. A parallel
 * byte array holds per-cell colour for rendering — the mask cannot carry it, and
 * keeping the two separate means the logic path never touches the render data.
 *
 * Deliberately NOT a u64 AND-bitboard: that is an AI/search optimisation
 * (Kirby703/tet-bit-board). For human play the 4-cell collision loop is nowhere
 * near the bottleneck, and the extra complexity would not pay for itself.
 *
 * Pure — no DOM, no `tiny` — so Node can test it.
 */

import { COLS, TOTAL_ROWS, FULL_ROW } from './constants.js';

export { COLS, TOTAL_ROWS, FULL_ROW };

export function makeBoard() {
  return {
    rows: new Uint16Array(TOTAL_ROWS),
    colors: new Uint8Array(TOTAL_ROWS * COLS), // 0 empty, else pieceId + 1
    /** top[x] = row of the highest filled cell in column x, or TOTAL_ROWS if empty. */
    top: new Int8Array(COLS).fill(TOTAL_ROWS),
  };
}

export function resetBoard(board) {
  board.rows.fill(0);
  board.colors.fill(0);
  board.top.fill(TOTAL_ROWS);
}

export function getCell(board, x, y) {
  return (board.rows[y] & (1 << x)) !== 0;
}

export function setCell(board, x, y, color) {
  if (color) {
    board.rows[y] |= 1 << x;
    board.colors[y * COLS + x] = color;
    if (y < board.top[x]) board.top[x] = y;
  } else {
    board.rows[y] &= ~(1 << x) & FULL_ROW;
    board.colors[y * COLS + x] = 0;
  }
}

export function isFullRow(board, y) {
  return board.rows[y] === FULL_ROW;
}

/** Recompute the column-height cache from scratch. O(COLS x TOTAL_ROWS). */
export function recomputeTop(board) {
  for (let x = 0; x < COLS; x++) {
    let t = TOTAL_ROWS;
    for (let y = 0; y < TOTAL_ROWS; y++) {
      if (board.rows[y] & (1 << x)) { t = y; break; }
    }
    board.top[x] = t;
  }
}

/**
 * Does `shape` at (px, py) overlap the board or leave the playfield?
 * Bounds are checked per cell; out-of-range x or below-the-floor counts as a
 * collision, above the ceiling does not (the buffer is legal space).
 */
export function collides(board, shape, px, py) {
  for (let i = 0; i < shape.length; i += 2) {
    const x = px + shape[i];
    const y = py + shape[i + 1];
    if (x < 0 || x >= COLS || y >= TOTAL_ROWS) return true;
    if (y >= 0 && (board.rows[y] & (1 << x))) return true;
  }
  return false;
}

/** Write a shape into the board. `color` is pieceId + 1. */
export function place(board, shape, px, py, color) {
  for (let i = 0; i < shape.length; i += 2) {
    const x = px + shape[i];
    const y = py + shape[i + 1];
    if (y < 0) continue;
    board.rows[y] |= 1 << x;
    board.colors[y * COLS + x] = color;
    if (y < board.top[x]) board.top[x] = y;
  }
}

/** How many rows are completely filled, without clearing them. */
export function countFullRows(board) {
  let n = 0;
  for (let y = 0; y < TOTAL_ROWS; y++) if (board.rows[y] === FULL_ROW) n++;
  return n;
}

/** Row indices of the full rows, bottom-up. */
export function fullRows(board) {
  const out = [];
  for (let y = TOTAL_ROWS - 1; y >= 0; y--) if (board.rows[y] === FULL_ROW) out.push(y);
  return out;
}

/**
 * Remove every full row and drop the rows above it down. Returns the count.
 * One pass, compacting in place: `write` trails `read` and only ever moves a
 * row downward, so no row is overwritten before it is read.
 */
export function clearLines(board) {
  const rows = board.rows;
  const colors = board.colors;
  let cleared = 0;
  let write = TOTAL_ROWS - 1;

  for (let read = TOTAL_ROWS - 1; read >= 0; read--) {
    if (rows[read] === FULL_ROW) { cleared++; continue; }
    if (write !== read) {
      rows[write] = rows[read];
      colors.copyWithin(write * COLS, read * COLS, read * COLS + COLS);
    }
    write--;
  }

  for (let r = write; r >= 0; r--) {
    rows[r] = 0;
    colors.fill(0, r * COLS, r * COLS + COLS);
  }

  if (cleared) recomputeTop(board);
  return cleared;
}

/**
 * FNV-1a over the occupancy masks. Used by the determinism tests to compare two
 * runs in one integer — cheap, and it catches any divergence.
 */
export function boardHash(board) {
  let h = 0x811c9dc5;
  for (let y = 0; y < TOTAL_ROWS; y++) {
    h ^= board.rows[y];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** True when every column is empty — used for perfect-clear detection. */
export function isEmpty(board) {
  for (let x = 0; x < COLS; x++) if (board.top[x] !== TOTAL_ROWS) return false;
  return true;
}
