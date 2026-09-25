/**
 * The simulation: game state and the fixed-rate tick.
 *
 * This is the whole game, minus input policy and rendering. `step()` advances
 * exactly one 60Hz frame; player actions are separate functions that Phase 2's
 * input layer calls. Keeping them apart is what makes the sim replayable: a
 * replay is a seed plus an ordered list of actions, and it reproduces only if
 * nothing here reads a clock or a random source.
 *
 * Nothing in this file touches the DOM, `tiny`, `performance` or `Date`.
 *
 * Pure — so Node can test it.
 */

import { PIECE } from './constants.js';
import {
  makeBoard, place, collides, fullRows, clearLines, boardHash,
} from './board.js';
import { SHAPES } from './pieces.js';
import { makeBag } from './rng.js';
import {
  LOCK_DELAY, MOVE_RESET_LIMIT, ROTATE_RESET_LIMIT, SHARE_RESET_BUDGET,
  LINE_CLEAR_DELAY, SPAWN_DELAY, gravityFrames,
  tryMove, tryRotate, dropRow, spawnPosition, isBlockedOut,
} from './rules.js';

/** How many upcoming pieces to keep queued (for the HUD preview). */
export const QUEUE_MIN = 5;

export const STATUS = {
  SPAWN: 'spawn',
  FALLING: 'falling',
  CLEARING: 'clearing',
  OVER: 'over',
};

export function makeGame(opts) {
  const o = opts || {};
  const seed = (o.seed === undefined ? 1 : o.seed) >>> 0;
  const level = o.level === undefined ? 1 : o.level;
  const state = {
    seed,
    board: makeBoard(),
    bag: makeBag(seed),
    queue: [],
    piece: -1,
    rot: 0,
    x: 0,
    y: 0,
    hold: -1,
    holdUsed: false,
    status: STATUS.SPAWN,
    timer: 0,
    gravity: 0,
    gravityFrames: gravityFrames(level),
    level,
    lockTimer: 0,
    moveResets: 0,
    rotateResets: 0,
    grounded: false,
    lines: 0,
    pieces: 0,
    score: 0,
    pendingRows: null,
    dead: false,
  };
  fillQueue(state);
  return state;
}

function fillQueue(state) {
  while (state.queue.length < QUEUE_MIN) state.queue.push(state.bag.next());
}

function isGrounded(state) {
  return collides(state.board, SHAPES[state.piece][state.rot], state.x, state.y + 1);
}

/* -------------------------------------------------------------------- tick */

export function step(state) {
  switch (state.status) {
    case STATUS.OVER: return;
    case STATUS.SPAWN: return tickSpawn(state);
    case STATUS.CLEARING: return tickClearing(state);
    default: return tickFalling(state);
  }
}

function tickSpawn(state) {
  if (state.timer > 0) { state.timer--; return; }

  const piece = state.queue.shift();
  fillQueue(state);
  const pos = spawnPosition(piece);

  state.piece = piece;
  state.rot = pos.rot;
  state.x = pos.x;
  state.y = pos.y;
  state.gravity = 0;
  state.lockTimer = 0;
  state.moveResets = 0;
  state.rotateResets = 0;
  state.grounded = false;
  state.holdUsed = false;

  if (isBlockedOut(state.board, piece, pos.x, pos.y, pos.rot)) {
    state.status = STATUS.OVER;
    state.dead = true;
    return;
  }
  state.pieces++;
  state.status = STATUS.FALLING;
}

function tickFalling(state) {
  if (isGrounded(state)) {
    // Resting: the lock timer runs, and only player actions can reset it.
    state.grounded = true;
    state.lockTimer++;
    if (state.lockTimer >= LOCK_DELAY) lockCurrent(state);
    return;
  }
  // Airborne: the lock timer does not accumulate — it measures resting time.
  state.grounded = false;
  state.lockTimer = 0;
  state.gravity++;
  if (state.gravity >= state.gravityFrames) {
    state.gravity = 0;
    state.y++; // safe: not grounded
  }
}

function tickClearing(state) {
  if (state.timer > 0) { state.timer--; return; }
  const n = clearLines(state.board);
  state.lines += n;
  state.pendingRows = null;
  state.timer = SPAWN_DELAY;
  state.status = STATUS.SPAWN;
}

function lockCurrent(state) {
  place(state.board, SHAPES[state.piece][state.rot], state.x, state.y, state.piece + 1);
  state.piece = -1;

  const rows = fullRows(state.board);
  if (rows.length) {
    state.pendingRows = rows;
    state.timer = LINE_CLEAR_DELAY;
    state.status = STATUS.CLEARING;
  } else {
    state.timer = SPAWN_DELAY;
    state.status = STATUS.SPAWN;
  }
}

/* ----------------------------------------------------------------- actions */

/**
 * Restart the lock timer after a player action, spending reset budget.
 * Only meaningful while resting — a move in mid-air costs nothing.
 */
function spendReset(state, kind) {
  if (!isGrounded(state)) return;
  if (SHARE_RESET_BUDGET) {
    if (state.moveResets + state.rotateResets >= MOVE_RESET_LIMIT) return;
    state.moveResets++;
  } else if (kind === 'move') {
    if (state.moveResets >= MOVE_RESET_LIMIT) return;
    state.moveResets++;
  } else {
    if (state.rotateResets >= ROTATE_RESET_LIMIT) return;
    state.rotateResets++;
  }
  state.lockTimer = 0;
}

export function move(state, dx) {
  if (state.status !== STATUS.FALLING) return false;
  const r = tryMove(state.board, state.piece, state.rot, state.x, state.y, dx, 0);
  if (!r) return false;
  state.x = r.x;
  spendReset(state, 'move');
  return true;
}

export function rotate(state, dir) {
  if (state.status !== STATUS.FALLING) return false;
  const r = tryRotate(state.board, state.piece, state.rot, state.x, state.y, dir);
  if (!r) return false;
  state.rot = r.rot;
  state.x = r.x;
  state.y = r.y;
  spendReset(state, 'rotate');
  return true;
}

/** One cell down. Returns false when already resting. */
export function softDrop(state) {
  if (state.status !== STATUS.FALLING) return false;
  const r = tryMove(state.board, state.piece, state.rot, state.x, state.y, 0, 1);
  if (!r) return false;
  state.y = r.y;
  state.gravity = 0;
  state.lockTimer = 0;
  return true;
}

/** Drop to the floor and lock immediately. Returns the distance fallen. */
export function hardDrop(state) {
  if (state.status !== STATUS.FALLING) return 0;
  const target = dropRow(state.board, state.piece, state.rot, state.x, state.y);
  const dist = target - state.y;
  state.y = target;
  lockCurrent(state);
  return dist;
}

/** Swap the active piece with the hold slot. Once per piece. */
export function holdPiece(state) {
  if (state.status !== STATUS.FALLING || state.holdUsed) return false;
  const cur = state.piece;

  let incoming;
  if (state.hold === -1) {
    incoming = state.queue.shift();
    fillQueue(state);
    state.hold = cur;
  } else {
    incoming = state.hold;
    state.hold = cur;
  }

  const pos = spawnPosition(incoming);
  state.piece = incoming;
  state.rot = pos.rot;
  state.x = pos.x;
  state.y = pos.y;
  state.gravity = 0;
  state.lockTimer = 0;
  state.moveResets = 0;
  state.rotateResets = 0;
  state.holdUsed = true;

  if (isBlockedOut(state.board, incoming, pos.x, pos.y, pos.rot)) {
    state.status = STATUS.OVER;
    state.dead = true;
    return true;
  }
  return true;
}

/** Where the active piece would land — for the ghost. */
export function ghostRow(state) {
  if (state.status !== STATUS.FALLING) return -1;
  return dropRow(state.board, state.piece, state.rot, state.x, state.y);
}

export function setLevel(state, level) {
  state.level = level;
  state.gravityFrames = gravityFrames(level);
}

/* ------------------------------------------------------------- diagnostics */

/** One integer summarising the whole simulation state, for determinism tests. */
export function gameHash(state) {
  let h = boardHash(state.board);
  h = (Math.imul(h ^ (state.piece + 2), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.rot + 1), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.x + 1), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.y + 1), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.lines + 1), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.pieces + 1), 0x01000193) >>> 0);
  h = (Math.imul(h ^ state.queue.join('').length, 0x01000193) >>> 0);
  return h >>> 0;
}

export { PIECE };
