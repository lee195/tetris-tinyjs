/**
 * Shared geometry and timing constants.
 *
 * Pure data — no DOM, no `tiny` — so every module below it is runnable under
 * Node for headless tests. Keep this file and everything that imports it free
 * of browser globals.
 */

/** Playfield width in cells. The row bitmask below depends on this being 10. */
export const COLS = 10;

/** Total rows, including the hidden buffer above the visible field. */
export const TOTAL_ROWS = 40;

/** Rows the player can see. */
export const VISIBLE_ROWS = 20;

/** First visible row index — rows [0, VISIBLE_TOP) are buffer. */
export const VISIBLE_TOP = TOTAL_ROWS - VISIBLE_ROWS;

/** A row with every column filled. Row-full test is a single compare. */
export const FULL_ROW = (1 << COLS) - 1;

/** Simulation rate. Rendering runs at rAF; the sim runs at this fixed rate. */
export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;

/**
 * Longest stall the loop will try to make up. A bigger gap (occluded window,
 * GC pause, breakpoint) is dropped rather than simulated. See loop.js.
 *
 * 100ms is ~6 ticks. The cap is really a bound on the tick BURST, not on time:
 * at level 1 gravity is 60 frames/cell so 6 ticks is a tenth of a cell, but at
 * level 20 it is one cell per frame, where 6 ticks would already be a visible
 * jump. Kept deliberately small for that reason — and the caller should pause
 * on blur, which is the real fix for occlusion.
 */
export const MAX_CATCHUP_MS = 100;

/** Column the spawn box's left edge sits at, for every piece. */
export const SPAWN_X = 3;

/** Piece ids. Order matters: the 7-bag deals these. */
export const PIECE = { I: 0, J: 1, L: 2, O: 3, S: 4, T: 5, Z: 6 };
export const PIECE_NAMES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
export const PIECE_COUNT = 7;
