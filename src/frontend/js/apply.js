/**
 * The input → simulation boundary: one tick of the whole pipeline.
 *
 * This exists so that everything between a key event and a moved piece can be
 * driven from Node. `main.js` calls `stepWithInput()` once per simulation tick
 * and does nothing else with input; every decision about *what* the input means
 * lives in `handling.js`, and every decision about *whether* it is legal lives
 * in `game.js`.
 *
 * Pure — no DOM, no `tiny` — so Node can test it.
 */

import {
  STATUS, step, move, rotate, softDrop, hardDrop, holdPiece, spendReset,
} from './game.js';
import { tick, onLock, shiftBlocked, SOFT_DROP } from './handling.js';

/**
 * One simulation tick: read the input, apply it, advance the game.
 *
 * Order is fixed, and it is the latency-critical detail from the plan: input is
 * applied **before** the tick, so a key pressed between frames is visible in
 * the frame it arrives rather than the one after.
 *
 * Returns the intent that was applied (a reused object — read it now).
 */
export function stepWithInput(game, handling, input) {
  // Captured before the intent is applied, because a hard drop locks the piece
  // inside `applyIntent` — reading it afterwards would miss that lock entirely.
  const hadPiece = game.piece !== -1;

  const it = tick(handling, input);
  applyIntent(game, handling, it);
  step(game);

  // `piece === -1` is the game's "no active piece" marker, set by the lock and
  // cleared on the next spawn — so this catches the transition exactly, rather
  // than `pieces`, which only increments after the spawn delay.
  if (hadPiece && game.piece === -1) onLock(handling);

  return it;
}

/**
 * Apply one tick's intent to the game.
 *
 * **Order matters and is fixed here:**
 *
 *   1. rotate   — a one-shot, applied before the shift so a rotation that kicks
 *                 the piece sideways is then corrected by the direction the
 *                 player is holding. It also makes "rotate then slide to the
 *                 wall" what a 0-ARR player gets, which is the predictable
 *                 reading of pressing both in one frame.
 *   2. shift    — the repeating action, so it gets the last word on x.
 *   3. hold     — a one-shot that replaces the piece outright, so it goes after
 *                 the position changes it would otherwise invalidate.
 *   4. soft drop, then hard drop — hard drop last, so it drops from the final
 *                 position.
 *
 * Returns true if the game was in a state to accept input. A false return does
 * **not** mean the intent was discarded: the DAS charge deliberately keeps
 * running through line clears and spawns so the next piece is already moving.
 */
export function applyIntent(game, handling, it) {
  if (game.status !== STATUS.FALLING) return false;

  if (it.rotateCW) rotate(game, 1);
  if (it.rotateCCW) rotate(game, -1);

  if (it.shift !== 0) {
    if (it.toWall) {
      // ARR 0. Bounded by the playfield width, so this terminates.
      let moved = 0;
      while (move(game, it.shift, true)) moved++;
      // One key press is one action, however many cells it crossed.
      if (moved) spendReset(game, 'move');
    } else if (!move(game, it.shift)) {
      shiftBlocked(handling);
    }
  }

  if (it.hold) holdPiece(game);

  if (it.softDrop === SOFT_DROP.TO_FLOOR) {
    while (softDrop(game)) { /* to the floor */ }
  } else if (it.softDrop === SOFT_DROP.ONE) {
    softDrop(game);
  }

  if (it.hardDrop) hardDrop(game);

  return true;
}

export { STATUS };
