/**
 * Canvas 2D renderer.
 *
 * Full redraw of the well every frame, no offscreen cache and no dirty rects.
 * That is a measurement, not a guess: Phase 0 timed clear + 400 blits at
 * 0.198 ms mean / 1 ms p99 (~1.2% of a 16.7 ms frame), and 0.225 ms at dpr 2.
 * At this board size a cache would be complexity bought with nothing.
 *
 * Two details are load-bearing:
 *
 *  - **The layout is computed in CSS pixels and the backing store is scaled by
 *    devicePixelRatio.** Phase 0 observed dpr flipping 1 -> 2 *live* when the
 *    window moves between the external monitor and the Retina panel, so dpr is
 *    re-read every frame and the backing store is resized when it changes. A
 *    value read once at startup goes blurry the first time the window moves.
 *  - **Nothing in the draw path allocates an array or an object.** The scratch
 *    the previews need is preallocated. (HUD text still produces a short string
 *    per value per frame — unavoidable, and negligible next to a fillRect.)
 *
 * The layout and preview geometry are exported as pure functions so they can be
 * tested under Node; the drawing functions need a canvas context and cannot.
 */

import {
  COLS, TOTAL_ROWS, VISIBLE_ROWS, VISIBLE_TOP, PIECE_COUNT,
} from './constants.js';
import { SHAPES, BOUNDS } from './pieces.js';
import { ghostRow, STATUS, ENDING } from './game.js';
import { formatTicks, ticksRemaining } from './modes.js';

/* ------------------------------------------------------------------ palette */

/** Indexed by pieceId + 1, so index 0 is "empty". */
const BASE = [
  '#000000',
  '#3ec6e0', // I
  '#4a6fe3', // J
  '#e8842c', // L
  '#e8c33a', // O
  '#4fc46a', // S
  '#a75ce0', // T
  '#e05050', // Z
];

/** Lighten a #rrggbb by `amt` per channel. Load-time only. */
export function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) + amt);
  const g = Math.min(255, ((n >> 8) & 255) + amt);
  const b = Math.min(255, (n & 255) + amt);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

const LIGHT = BASE.map((c, i) => (i === 0 ? c : lighten(c, 46)));

const WELL_BG = '#111419';
const PAGE_BG = '#0b0d11';
const FRAME = '#2a3038';
const LABEL = '#6c7686';
const VALUE = '#dde3ec';
/** The raced run's stack: present but clearly not yours. */
const GHOST = 'rgba(150, 170, 200, 0.36)';

/* ------------------------------------------------------------------- layout */

const PAD = 10;
/** Gap between the well and the side panel, and the panel's width, in cells. */
const GAP_CELLS = 0.5;
const PANEL_CELLS = 4.5;
/** Smallest cell worth drawing; below this the well is unreadable anyway. */
export const MIN_CELL = 4;

/**
 * Work out the geometry for a viewport, in CSS pixels.
 *
 * Cell size is an integer so cell edges land on whole pixels (and on whole
 * device pixels at dpr 1 and 2), which is what keeps the grid crisp. Height
 * decides the size, then width caps it — a wide, short window is height-bound
 * and a narrow, tall one is width-bound, and both end up centred.
 *
 * Note there is no `dpr` parameter: the layout is defined in CSS pixels and the
 * caller scales the context. That keeps a dpr change from moving anything.
 */
export function computeLayout(cssW, cssH) {
  const availH = Math.max(1, cssH - PAD * 2);
  const availW = Math.max(1, cssW - PAD * 2);
  const colsTotal = COLS + GAP_CELLS + PANEL_CELLS;

  let cell = Math.floor(availH / VISIBLE_ROWS);
  const byWidth = Math.floor(availW / colsTotal);
  if (cell > byWidth) cell = byWidth;
  if (!(cell >= MIN_CELL)) cell = MIN_CELL;

  const boardW = COLS * cell;
  const boardH = VISIBLE_ROWS * cell;
  const gap = Math.max(2, Math.round(GAP_CELLS * cell));
  const panelW = Math.max(3 * cell, Math.round(PANEL_CELLS * cell));
  const totalW = boardW + gap + panelW;

  const boardX = Math.floor((cssW - totalW) / 2);
  const boardY = Math.floor((cssH - boardH) / 2);

  return {
    cell,
    boardX,
    boardY,
    boardW,
    boardH,
    panelX: boardX + boardW + gap,
    panelY: boardY,
    panelW,
    panelH: boardH,
    gap,
    totalW,
    totalH: boardH,
    cssW,
    cssH,
  };
}

/** Device-pixel x of a column. */
export function boardCellX(layout, x) {
  return layout.boardX + x * layout.cell;
}

/**
 * Device-pixel y of a board row. Rows [0, VISIBLE_TOP) are the hidden buffer,
 * so row VISIBLE_TOP is the top of the well.
 */
export function boardCellY(layout, y) {
  return layout.boardY + (y - VISIBLE_TOP) * layout.cell;
}

/**
 * Top-left of a piece drawn centred in a box, in CSS pixels.
 *
 * Centres on the piece's *occupied* bounds rather than its bounding box, so an
 * I in a 4x4 box and an O in a 2x2 box both look centred rather than each
 * sitting wherever its grid happens to put them.
 */
export function pieceBoxOrigin(piece, rot, size, boxX, boxY, boxW, boxH) {
  const b = BOUNDS[piece][rot];
  const w = (b.maxX - b.minX + 1) * size;
  const h = (b.maxY - b.minY + 1) * size;
  return {
    x: boxX + Math.floor((boxW - w) / 2) - b.minX * size,
    y: boxY + Math.floor((boxH - h) / 2) - b.minY * size,
  };
}

/* ----------------------------------------------------------------- renderer */

export function makeRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  return {
    canvas,
    ctx,
    layout: computeLayout(canvas.clientWidth || 1, canvas.clientHeight || 1),
    // Seeded from the real dpr rather than 0, so "dpr is always positive" holds
    // from construction. syncSize() still runs on the first frame and takes
    // over from here.
    dpr: window.devicePixelRatio || 1,
    viewW: 0,
    viewH: 0,
    /** Last frame's draw time in ms, for the perf overlay. */
    drawMs: 0,
  };
}

/**
 * Match the backing store to the viewport, and rebuild the layout if it moved.
 *
 * Called every frame. The early-out matters: assigning `canvas.width` clears
 * the canvas and reallocates the backing store, so doing it unconditionally
 * would be both slow and visible.
 */
export function syncSize(r) {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (dpr === r.dpr && w === r.viewW && h === r.viewH) return false;

  r.dpr = dpr;
  r.viewW = w;
  r.viewH = h;
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (r.canvas.width !== bw) r.canvas.width = bw;
  if (r.canvas.height !== bh) r.canvas.height = bh;
  // Draw in CSS pixels from here on.
  r.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  r.layout = computeLayout(w, h);
  return true;
}

/* ------------------------------------------------------------------ drawing */

/** One block: a fill inset by 1px, so the well shows through as the grid. */
function block(ctx, x, y, size, fill, light) {
  ctx.fillStyle = fill;
  ctx.fillRect(x + 1, y + 1, size - 2, size - 2);
  // A single highlight along the top edge is enough to make a stack read as
  // discrete blocks. More bevel than this stops paying for itself.
  ctx.fillStyle = light;
  ctx.fillRect(x + 1, y + 1, size - 2, size >= 12 ? 2 : 1);
}

function outline(ctx, x, y, size, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 1.5, y + 1.5, size - 3, size - 3);
}

/** Draw a piece's cells at an absolute board position. Skips the hidden buffer. */
function drawShape(ctx, layout, shape, px, py, fill, light) {
  const cell = layout.cell;
  for (let i = 0; i < shape.length; i += 2) {
    const y = py + shape[i + 1];
    if (y < VISIBLE_TOP) continue;
    block(ctx, boardCellX(layout, px + shape[i]), boardCellY(layout, y), cell, fill, light);
  }
}

/**
 * Outline a board's placed blocks — the ghost run's stack.
 *
 * Outlines rather than fills, because this is drawn under the live board: a
 * filled ghost would hide the board being played, while an outline shows through
 * the gaps and still reads as a height comparison at a glance.
 */
function drawStack(ctx, layout, board) {
  const cell = layout.cell;
  ctx.strokeStyle = GHOST;
  ctx.lineWidth = 1;
  for (let y = VISIBLE_TOP; y < TOTAL_ROWS; y++) {
    const mask = board.rows[y];
    if (mask === 0) continue;
    const rowY = boardCellY(layout, y);
    for (let x = 0; x < COLS; x++) {
      if (!(mask & (1 << x))) continue;
      ctx.strokeRect(boardCellX(layout, x) + 0.5, rowY + 0.5, cell - 1, cell - 1);
    }
  }
}

function text(ctx, str, x, y, color, font) {
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.fillText(str, x, y);
}

/**
 * Draw one frame. Everything the renderer needs is read from `game`; `flags`
 * carries the UI state that is not part of the simulation, and `ghost` — when
 * present — is a second game whose stack is drawn behind the live one.
 */
export function draw(r, game, flags, ghost) {
  const t0 = performance.now();
  syncSize(r);
  const ctx = r.ctx;
  const L = r.layout;
  const cell = L.cell;

  ctx.fillStyle = PAGE_BG;
  ctx.fillRect(0, 0, L.cssW, L.cssH);

  // Well
  ctx.fillStyle = WELL_BG;
  ctx.fillRect(L.boardX, L.boardY, L.boardW, L.boardH);

  // The ghost run's stack goes *under* the live one, so it reads as a silhouette
  // visible through the gaps in your own board. Drawn on top it would obscure
  // the board you are actually playing, which is the opposite of useful.
  if (ghost) drawStack(ctx, L, ghost.board);

  // Placed blocks. Empty rows are skipped by a single mask compare, which is
  // most of them.
  const board = game.board;
  for (let y = VISIBLE_TOP; y < TOTAL_ROWS; y++) {
    const mask = board.rows[y];
    if (mask === 0) continue;
    const rowY = boardCellY(L, y);
    const base = y * COLS;
    for (let x = 0; x < COLS; x++) {
      if (mask & (1 << x)) {
        const c = board.colors[base + x];
        block(ctx, boardCellX(L, x), rowY, cell, BASE[c] || BASE[1], LIGHT[c] || LIGHT[1]);
      }
    }
  }

  // Ghost, then the active piece on top of it. The ghost is suppressed once the
  // piece is resting on it — an outline exactly under the piece is just noise.
  if (game.status === STATUS.FALLING && game.piece >= 0) {
    const gy = ghostRow(game);
    const shape = SHAPES[game.piece][game.rot];
    if (gy !== game.y) {
      ctx.globalAlpha = 0.18;
      drawShape(ctx, L, shape, game.x, gy, BASE[game.piece + 1], BASE[game.piece + 1]);
      ctx.globalAlpha = 1;
      ctx.globalAlpha = 0.5;
      for (let i = 0; i < shape.length; i += 2) {
        const y = gy + shape[i + 1];
        if (y < VISIBLE_TOP) continue;
        outline(ctx, boardCellX(L, game.x + shape[i]), boardCellY(L, y), cell,
          BASE[game.piece + 1]);
      }
      ctx.globalAlpha = 1;
    }
    drawShape(ctx, L, shape, game.x, game.y, BASE[game.piece + 1], LIGHT[game.piece + 1]);
  }

  // Well frame, drawn after the blocks so it sits on top of the edges.
  ctx.strokeStyle = FRAME;
  ctx.lineWidth = 1;
  ctx.strokeRect(L.boardX - 0.5, L.boardY - 0.5, L.boardW + 1, L.boardH + 1);

  drawPanel(ctx, L, game, flags);
  if (flags && flags.banner) drawBanner(ctx, L, flags.banner);
  if (flags && flags.over) drawOverlay(ctx, L, game);
  else if (flags && flags.paused) drawOverlay(ctx, L, null);

  r.drawMs = performance.now() - t0;
}

/**
 * The transient "TETRIS" / "T-SPIN DOUBLE" / "B2B" callout, near the top of the
 * well so it never covers the stack the player is reading.
 */
function drawBanner(ctx, L, text) {
  const size = Math.max(11, Math.round(L.cell * 0.62));
  ctx.textAlign = 'center';
  const y = L.boardY + Math.round(L.cell * 1.8);
  const cx = L.boardX + L.boardW / 2;
  const font = '700 ' + size + 'px ui-monospace, monospace';
  // A dark copy one pixel down, so the callout stays readable over any colour
  // of block it happens to land on.
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.font = font;
  ctx.fillText(text, cx + 1, y + 1);
  ctx.fillStyle = '#f2f6fb';
  ctx.fillText(text, cx, y);
  ctx.textAlign = 'left';
}

/* -------------------------------------------------------------------- panel */

function drawPanel(ctx, L, game, flags) {
  const cell = L.cell;
  const x = L.panelX;
  const w = L.panelW;
  const labelSize = Math.max(9, Math.round(cell * 0.42));
  const valueSize = Math.max(12, Math.round(cell * 0.8));
  const labelFont = '600 ' + labelSize + 'px ui-monospace, monospace';
  const valueFont = '600 ' + valueSize + 'px ui-monospace, monospace';
  const mode = game.mode;

  const mini = Math.max(3, Math.round(cell * 0.45));
  const boxH = mini * 3 + 8;

  let y = L.panelY;

  // Mode, and the clock for the modes that are timed. The clock is derived from
  // the simulation's tick count, so it can never disagree with the game state.
  // A prefix marks the two states where what you are watching is not a live run.
  let tag = mode.label.toUpperCase();
  let tagColour = LABEL;
  if (flags && flags.watching) { tag = 'REPLAY · ' + tag; tagColour = VALUE; }
  else if (flags && flags.ghost) { tag = 'GHOST · ' + tag; tagColour = VALUE; }
  text(ctx, tag, x, y + labelSize, tagColour, labelFont);
  y += Math.round(cell * 0.6);
  if (mode.showClock) {
    const shown = mode.timeLimitTicks
      ? ticksRemaining(mode, game.ticks)
      : game.ticks;
    text(ctx, formatTicks(shown), x, y + valueSize, VALUE, valueFont);
    y += Math.round(cell * 0.95);
  }

  // Hold
  text(ctx, 'HOLD', x, y + labelSize, LABEL, labelFont);
  y += Math.round(cell * 0.55);
  box(ctx, L, x, y, w, boxH);
  if (game.hold >= 0) {
    const o = pieceBoxOrigin(game.hold, 0, mini, x, y, w, boxH);
    drawMini(ctx, SHAPES[game.hold][0], o.x, o.y, mini, game.hold, game.holdUsed);
  }
  y += boxH + Math.round(cell * 0.4);

  // Next queue
  text(ctx, 'NEXT', x, y + labelSize, LABEL, labelFont);
  y += Math.round(cell * 0.55);
  const n = Math.min(game.queue.length, 5);
  for (let i = 0; i < n; i++) {
    const piece = game.queue[i];
    box(ctx, L, x, y, w, boxH);
    const o = pieceBoxOrigin(piece, 0, mini, x, y, w, boxH);
    drawMini(ctx, SHAPES[piece][0], o.x, o.y, mini, piece, false);
    y += boxH + 4;
  }

  // Stats, anchored to the bottom of the panel so they do not move as the
  // queue grows or shrinks.
  const lineH = Math.round(cell * 1.55);
  const sy = L.panelY + L.panelH - lineH * 3;
  stat(ctx, 'SCORE', game.score, x, sy, labelSize, valueSize, labelFont, valueFont);
  stat(ctx, 'LINES', game.lines, x, sy + lineH, labelSize, valueSize, labelFont, valueFont);
  stat(ctx, 'LEVEL', game.level, x, sy + lineH * 2, labelSize, valueSize, labelFont, valueFont);
}

function box(ctx, L, x, y, w, h) {
  ctx.fillStyle = '#151920';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = FRAME;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function drawMini(ctx, shape, ox, oy, size, piece, dim) {
  const fill = BASE[piece + 1];
  const light = LIGHT[piece + 1];
  if (dim) ctx.globalAlpha = 0.4;
  for (let i = 0; i < shape.length; i += 2) {
    block(ctx, ox + shape[i] * size, oy + shape[i + 1] * size, size, fill, light);
  }
  if (dim) ctx.globalAlpha = 1;
}

function stat(ctx, label, value, x, y, labelSize, valueSize, labelFont, valueFont) {
  text(ctx, label, x, y + labelSize, LABEL, labelFont);
  text(ctx, String(value), x, y + labelSize + valueSize, VALUE, valueFont);
}

function drawOverlay(ctx, L, game) {
  const cx = L.boardX + L.boardW / 2;
  const cy = L.boardY + L.boardH / 2;
  ctx.fillStyle = 'rgba(8, 10, 14, 0.78)';
  ctx.fillRect(L.boardX, L.boardY, L.boardW, L.boardH);
  ctx.textAlign = 'center';

  const titleSize = Math.max(14, Math.round(L.cell * 1.05));
  const bodySize = Math.max(10, Math.round(L.cell * 0.48));
  const titleFont = '700 ' + titleSize + 'px ui-monospace, monospace';
  const bodyFont = '500 ' + bodySize + 'px ui-monospace, monospace';

  // game === null means paused rather than finished.
  if (!game) {
    text(ctx, 'PAUSED', cx, cy, '#eef2f7', titleFont);
    text(ctx, 'focus to resume', cx, cy + titleSize, LABEL, bodyFont);
    ctx.textAlign = 'left';
    return;
  }

  const r = game.result;
  let title = 'GAME OVER';
  if (r && r.reason === ENDING.GOAL) title = 'COMPLETE';
  else if (r && r.reason === ENDING.TIME) title = 'TIME';

  text(ctx, title, cx, cy - titleSize * 0.7, '#eef2f7', titleFont);

  if (r) {
    const lh = Math.round(bodySize * 1.8);
    let y = cy + Math.round(titleSize * 0.4);
    text(ctx, r.mode.toUpperCase() + '   ' + formatTicks(r.ticks), cx, y, VALUE, bodyFont);
    y += lh;
    text(ctx, 'SCORE ' + r.score, cx, y, VALUE, bodyFont);
    y += lh;
    text(ctx, r.lines + ' LINES   LEVEL ' + r.level, cx, y, VALUE, bodyFont);
    y += Math.round(lh * 1.7);
    text(ctx, 'Enter to play again', cx, y, LABEL, bodyFont);
  }
  ctx.textAlign = 'left';
}

export { BASE, LIGHT, PIECE_COUNT };
