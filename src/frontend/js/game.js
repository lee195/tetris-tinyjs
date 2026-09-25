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
  makeBoard, place, collides, fullRows, clearLines, boardHash, isPerfectClear,
} from './board.js';
import { SHAPES } from './pieces.js';
import { makeBag } from './rng.js';
import {
  LOCK_DELAY, MOVE_RESET_LIMIT, ROTATE_RESET_LIMIT, SHARE_RESET_BUDGET,
  LINE_CLEAR_DELAY_DEFAULT, ARE_DEFAULT, gravityFrames, detectTSpin, TSPIN,
  tryMove, tryRotate, dropRow, spawnPosition, isBlockedOut,
} from './rules.js';
import { scoreClear, dropPoints } from './scoring.js';
import { modeConfig, levelForLines } from './modes.js';

/** How many upcoming pieces to keep queued (for the HUD preview). */
export const QUEUE_MIN = 5;

export const STATUS = {
  SPAWN: 'spawn',
  FALLING: 'falling',
  CLEARING: 'clearing',
  OVER: 'over',
};

/**
 * Why a run ended. Kept as a reason on the result rather than as separate
 * statuses, because everything downstream — the overlay, the final stats, the
 * replay header — treats all three the same way.
 */
export const ENDING = {
  TOPOUT: 'topout',
  GOAL: 'goal',
  TIME: 'time',
};

export function makeGame(opts) {
  const o = opts || {};
  const seed = (o.seed === undefined ? 1 : o.seed) >>> 0;
  const mode = modeConfig(o.mode);
  // A player's speed preference overrides the mode's default. Floored at 1
  // because gravityFrames(0) would leave a piece that never falls.
  const startLevel = Math.max(1, (o.startLevel === undefined ? mode.startLevel : o.startLevel) | 0);
  const level = o.level === undefined ? startLevel : o.level;
  const state = {
    seed,
    mode,
    startLevel,
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
    /** Ticks the next piece waits after a lock, and the line-clear pause. */
    are: ARE_DEFAULT,
    lineClearDelay: LINE_CLEAR_DELAY_DEFAULT,
    lines: 0,
    pieces: 0,
    score: 0,
    /** Combo counter. -1 means no chain, so the first clear of one is combo 0. */
    combo: -1,
    backToBack: false,
    /** The last lock's scoring outcome, for the HUD. */
    lastClear: null,
    perfect: false,
    /**
     * What the player did most recently. A T-spin requires the last successful
     * action to have been a rotation, so this is not bookkeeping — it is part of
     * the rules.
     */
    lastAction: 'none',
    lastKick: 0,
    /** Total ticks elapsed. The sim's only notion of time; see modes.js. */
    ticks: 0,
    /** Filled in when the run ends. */
    result: null,
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
  if (state.status === STATUS.OVER) return;

  state.ticks++;
  // The clock is a tick budget, not a wall clock: a time-limited run has to be
  // exactly reproducible from a seed and an input log.
  const limit = state.mode.timeLimitTicks;
  if (limit && state.ticks >= limit) return endRun(state, ENDING.TIME);

  switch (state.status) {
    case STATUS.SPAWN: return tickSpawn(state);
    case STATUS.CLEARING: return tickClearing(state);
    default: return tickFalling(state);
  }
}

/**
 * End the run and record why. All three endings — top-out, goal reached, time
 * up — land in the same status, because nothing downstream treats them
 * differently.
 */
function endRun(state, reason) {
  state.status = STATUS.OVER;
  if (reason === ENDING.TOPOUT) state.dead = true;
  state.result = {
    mode: state.mode.id,
    reason,
    lines: state.lines,
    score: state.score,
    pieces: state.pieces,
    level: state.level,
    ticks: state.ticks,
  };
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
  // A fresh piece has not been moved or rotated, so it cannot be a T-spin.
  state.lastAction = 'none';
  state.lastKick = 0;

  if (isBlockedOut(state.board, piece, pos.x, pos.y, pos.rot)) {
    return endRun(state, ENDING.TOPOUT);
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

  // The level curve lives in the simulation, not the driver: it changes gravity,
  // so a replay would diverge if the driver owned it.
  const mode = state.mode;
  if (mode.linesPerLevel) {
    setLevel(state, levelForLines(mode, state.lines, state.startLevel));
  }
  if (mode.goalLines && state.lines >= mode.goalLines) {
    return endRun(state, ENDING.GOAL);
  }

  state.timer = state.are;
  state.status = STATUS.SPAWN;
}

function lockCurrent(state) {
  // A T-spin needs three things: the piece is a T, the last successful action
  // was a rotation rather than a move, and the corner test passes. The corner
  // test runs before placement — the T never occupies a box corner, so it would
  // give the same answer either way, but the intent is clearer this way.
  const tspin = (state.piece === PIECE.T && state.lastAction === 'rotate')
    ? detectTSpin(state.board, state.rot, state.x, state.y, state.lastKick)
    : TSPIN.NONE;

  place(state.board, SHAPES[state.piece][state.rot], state.x, state.y, state.piece + 1);
  state.piece = -1;

  const rows = fullRows(state.board);
  // Scored against the level at the moment of the lock, so a level-up earned by
  // this clear applies to the next one rather than retroactively.
  const scored = scoreClear({
    lines: rows.length,
    tspin,
    level: state.level,
    combo: state.combo,
    backToBack: state.backToBack,
    perfect: rows.length > 0 && isPerfectClear(state.board),
  });

  state.score += scored.points;
  state.combo = scored.combo;
  state.backToBack = scored.backToBack;
  state.lastClear = scored;
  state.perfect = scored.lines > 0 && isPerfectClear(state.board);

  if (rows.length) {
    state.pendingRows = rows;
    state.timer = state.lineClearDelay;
    state.status = STATUS.CLEARING;
  } else {
    state.timer = state.are;
    state.status = STATUS.SPAWN;
  }
}

/* ----------------------------------------------------------------- actions */

/**
 * Restart the lock timer after a player action, spending reset budget.
 * Only meaningful while resting — a move in mid-air costs nothing.
 *
 * Exported because a multi-cell auto-shift is ONE player action and must cost
 * one reset, not one per cell. `apply.js` moves the cells with `move(…, true)`
 * and then calls this once. Charging per cell would make ARR 0 — a slide of up
 * to nine cells — burn most of the budget on a single key press.
 */
export function spendReset(state, kind) {
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

/**
 * Move one cell sideways. Returns false when blocked.
 *
 * `skipReset` suppresses the lock-timer reset, for the intermediate cells of a
 * single auto-shift action — see `spendReset`.
 */
export function move(state, dx, skipReset) {
  if (state.status !== STATUS.FALLING) return false;
  const r = tryMove(state.board, state.piece, state.rot, state.x, state.y, dx, 0);
  if (!r) return false;
  state.x = r.x;
  // A move after a rotation invalidates a T-spin — see lockCurrent.
  state.lastAction = 'move';
  if (!skipReset) spendReset(state, 'move');
  return true;
}

export function rotate(state, dir) {
  if (state.status !== STATUS.FALLING) return false;
  const r = tryRotate(state.board, state.piece, state.rot, state.x, state.y, dir);
  if (!r) return false;
  state.rot = r.rot;
  state.x = r.x;
  state.y = r.y;
  state.lastAction = 'rotate';
  state.lastKick = r.kick;
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
  // A soft drop is a movement, so it invalidates a pending T-spin. The common
  // T-spin sets up next to the slot and rotates in, so the rotation is last.
  state.lastAction = 'move';
  state.score += dropPoints(1, false);
  return true;
}

/** Drop to the floor and lock immediately. Returns the distance fallen. */
export function hardDrop(state) {
  if (state.status !== STATUS.FALLING) return 0;
  const target = dropRow(state.board, state.piece, state.rot, state.x, state.y);
  const dist = target - state.y;
  state.y = target;
  // Points before the lock, because the lock resets the action tracking.
  state.score += dropPoints(dist, true);
  state.lastAction = 'move';
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
  // The swapped-in piece is freshly spawned, so it cannot be a T-spin.
  state.lastAction = 'none';
  state.lastKick = 0;

  if (isBlockedOut(state.board, incoming, pos.x, pos.y, pos.rot)) {
    endRun(state, ENDING.TOPOUT);
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

/**
 * Change how fast the run's pieces fall.
 *
 * Re-derives the level from the current line count, so a change takes effect at
 * once rather than waiting for the next level-up. A speed preference should be
 * felt while it is being dragged, not deferred to the next ten lines.
 */
export function setStartLevel(state, level) {
  state.startLevel = Math.max(1, level | 0);
  setLevel(state, levelForLines(state.mode, state.lines, state.startLevel));
}

/**
 * Set the lock-to-spawn and line-clear delays, in ticks.
 *
 * These live on the game state rather than in the handling config because they
 * are game rules, not input policy — but a Phase 4 settings screen wants them
 * beside DAS/ARR, so it should hold one config object and fan it out to
 * `setHandling()` and `setTiming()`.
 *
 * Lowering `are` while a spawn is already pending is safe: the timer is only
 * ever compared against zero, so a shorter delay simply takes effect.
 */
export function setTiming(state, cfg) {
  if (cfg.are !== undefined) state.are = Math.max(0, cfg.are | 0);
  if (cfg.lineClearDelay !== undefined) {
    state.lineClearDelay = Math.max(0, cfg.lineClearDelay | 0);
  }
  return state;
}

/* ------------------------------------------------------------- diagnostics */

/**
 * One integer summarising the whole simulation state, for determinism tests.
 *
 * Everything that can affect the future has to be in here — a field left out is
 * a divergence the tests cannot see. Score and combo are included not because
 * they affect play but because they are what a replay is checked against.
 */
export function gameHash(state) {
  let h = boardHash(state.board);
  h = (Math.imul(h ^ (state.piece + 2), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.rot + 1), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.x + 1), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.y + 1), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.lines + 1), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.pieces + 1), 0x01000193) >>> 0);
  h = (Math.imul(h ^ state.queue.join('').length, 0x01000193) >>> 0);
  // Timing config is part of the simulated state: two runs with different ARE
  // or line-clear delay are different games and must not hash equal.
  h = (Math.imul(h ^ (state.are + 1), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.lineClearDelay + 1), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.score | 0), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.level + 1), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.combo + 2), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.backToBack ? 7 : 11), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.ticks + 1), 0x01000193) >>> 0);
  h = (Math.imul(h ^ (state.status === STATUS.OVER ? 13 : 17), 0x01000193) >>> 0);
  return h >>> 0;
}

export { PIECE, TSPIN };
