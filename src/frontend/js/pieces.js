/**
 * Tetromino shapes and SRS kick tables.
 *
 * Shapes are written as ASCII grids and flattened once at module load — the
 * grids are self-verifying by eye, and the flattening is a one-time cost that
 * leaves a flat Int8Array on the hot path. Rotation is a table lookup, never a
 * coordinate transform.
 *
 * Coordinate convention: x right, **y down**, origin at the bounding box's
 * top-left. The published SRS kick tables use y UP, so `kick()` negates y in
 * exactly one place rather than scattering sign flips through the data.
 *
 * Pure — no DOM, no `tiny` — so Node can test it.
 */

import { PIECE, SPAWN_X, VISIBLE_TOP } from './constants.js';

/** rotation index -> grid. Index 0 is spawn, then clockwise. */
const GRIDS = [
  // I — 4x4 box
  [
    ['....', 'XXXX', '....', '....'],
    ['..X.', '..X.', '..X.', '..X.'],
    ['....', '....', 'XXXX', '....'],
    ['.X..', '.X..', '.X..', '.X..'],
  ],
  // J — 3x3 box
  [
    ['X..', 'XXX', '...'],
    ['.XX', '.X.', '.X.'],
    ['...', 'XXX', '..X'],
    ['.X.', '.X.', 'XX.'],
  ],
  // L — 3x3 box
  [
    ['..X', 'XXX', '...'],
    ['.X.', '.X.', '.XX'],
    ['...', 'XXX', 'X..'],
    ['XX.', '.X.', '.X.'],
  ],
  // O — 2x2 box, rotation-invariant
  [
    ['XX', 'XX'],
    ['XX', 'XX'],
    ['XX', 'XX'],
    ['XX', 'XX'],
  ],
  // S — 3x3 box
  [
    ['.XX', 'XX.', '...'],
    ['.X.', '.XX', '..X'],
    ['...', '.XX', 'XX.'],
    ['X..', 'XX.', '.X.'],
  ],
  // T — 3x3 box
  [
    ['.X.', 'XXX', '...'],
    ['.X.', '.XX', '.X.'],
    ['...', 'XXX', '.X.'],
    ['.X.', 'XX.', '.X.'],
  ],
  // Z — 3x3 box
  [
    ['XX.', '.XX', '...'],
    ['..X', '.XX', '.X.'],
    ['...', 'XX.', '.XX'],
    ['.X.', 'XX.', 'X..'],
  ],
];

/** Flatten an ASCII grid into [x0,y0,x1,y1,...]. */
function flatten(grid) {
  const out = [];
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] === 'X') out.push(x, y);
    }
  }
  if (out.length !== 8) {
    throw new Error('piece grid must have exactly 4 cells, got ' + out.length / 2);
  }
  return Int8Array.from(out);
}

/** SHAPES[piece][rotation] -> Int8Array of 4 (x,y) pairs. */
export const SHAPES = GRIDS.map((states) => states.map(flatten));

/** BOUNDS[piece][rotation] -> {minX, minY, maxX, maxY} of occupied cells. */
export const BOUNDS = SHAPES.map((states) =>
  states.map((s) => {
    let minX = 99, minY = 99, maxX = -99, maxY = -99;
    for (let i = 0; i < s.length; i += 2) {
      if (s[i] < minX) minX = s[i];
      if (s[i] > maxX) maxX = s[i];
      if (s[i + 1] < minY) minY = s[i + 1];
      if (s[i + 1] > maxY) maxY = s[i + 1];
    }
    return { minX, minY, maxX, maxY };
  })
);

/**
 * Spawn row for each piece's bounding box, so the piece's topmost occupied cell
 * lands on the first visible row. Derived from the shape rather than hardcoded,
 * because the pieces' boxes differ in height (I is 4 tall, O is 2).
 */
export const SPAWN_Y = BOUNDS.map((states) => VISIBLE_TOP - states[0].minY);

export { SPAWN_X };

/**
 * SRS kick offsets, transcribed from the published tables which use y-UP, and
 * flipped to y-DOWN here. `pairs` are [x, yUp].
 */
function kick(pairs) {
  const out = [];
  for (const [x, y] of pairs) out.push(x, -y);
  return Int8Array.from(out);
}

/** Kicks for J, L, S, T, Z (they share one table). */
export const JLSTZ_KICKS = {
  '0>1': kick([[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]]),
  '1>0': kick([[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]),
  '1>2': kick([[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]),
  '2>1': kick([[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]]),
  '2>3': kick([[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]),
  '3>2': kick([[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]]),
  '3>0': kick([[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]]),
  '0>3': kick([[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]),
};

/** Kicks for I, which has its own table. */
export const I_KICKS = {
  '0>1': kick([[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]]),
  '1>0': kick([[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]]),
  '1>2': kick([[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]]),
  '2>1': kick([[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]]),
  '2>3': kick([[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]]),
  '3>2': kick([[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]]),
  '3>0': kick([[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]]),
  '0>3': kick([[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]]),
};

/** The kick table for a piece, or null when rotation needs no offset (O). */
export function kicksFor(piece) {
  if (piece === PIECE.I) return I_KICKS;
  if (piece === PIECE.O) return null;
  return JLSTZ_KICKS;
}

/** Next rotation index. dir is +1 (cw) or -1 (ccw). */
export function rotateIndex(rot, dir) {
  return (rot + (dir > 0 ? 1 : 3)) & 3;
}
