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
  // Captured before the intent is applied, because a hard drop locks *inside*
  // `applyIntent` — reading either of these afterwards would miss that lock.
  const clearBefore = game.lastClear;

  const it = tick(handling, input);
  applyIntent(game, handling, it);
  step(game);

  // A lock is detected from `lastClear` identity, and deliberately not from
  // `piece === -1`.
  //
  // `lockCurrent` assigns a fresh `lastClear` on EVERY lock, clear or not, so
  // identity is exact — checked against the cells placed on the board, which is
  // an independent count. The `piece === -1` marker is not exact: a hard drop
  // locks inside `applyIntent`, so with ARE 0 the `step` above spawns in the
  // same tick and the marker is never visible from out here. That silently
  // skipped this call for every hard drop at the default ARE, which is a DCD
  // bug — DCD is off by default, and that is the only reason it went unnoticed.
  //
  // (Gravity locks are unaffected either way: they happen inside `step` and end
  // their own tick, so the marker does survive those.)
  if (game.lastClear !== clearBefore) onLock(handling);

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
 *
 * Also records what actually landed on `it.didRotate`, `it.didHold` and
 * `it.didHardDrop` — see the note on those fields in `makeIntent`. They are
 * cleared at the top of every call, so they describe this tick and no other.
 */
export function applyIntent(game, handling, it) {
  // Cleared BEFORE the early return below, not after it. A tick where the game
  // will not accept input would otherwise leave the previous tick's outcomes in
  // place, and a caller reading them would see an action from two ticks ago —
  // which is precisely how a one-shot sound effect fires twice.
  it.didRotate = false;
  it.didHold = false;
  it.didHardDrop = false;

  if (game.status !== STATUS.FALLING) return false;

  if (it.rotateCW && rotate(game, 1)) it.didRotate = true;
  if (it.rotateCCW && rotate(game, -1)) it.didRotate = true;

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

  // `holdPiece` returns false only when the hold is unavailable — once per
  // piece — so its return value is the success signal.
  if (it.hold) it.didHold = holdPiece(game);

  if (it.softDrop === SOFT_DROP.TO_FLOOR) {
    while (softDrop(game)) { /* to the floor */ }
  } else if (it.softDrop === SOFT_DROP.ONE) {
    softDrop(game);
  }

  // The status is re-checked rather than assumed. A hold above can top the game
  // out, and `hardDrop` on a finished game returns 0 without locking — so
  // trusting the distance would report a drop that never happened.
  if (it.hardDrop && game.status === STATUS.FALLING) {
    hardDrop(game);
    it.didHardDrop = true;
  }

  return true;
}

export { STATUS };
