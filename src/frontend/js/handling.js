/**
 * Input policy: what the player's held keys mean on this tick.
 *
 * This is the competitive core. Every counter here is a whole number of ticks,
 * never a timestamp — which is what makes a replay reproduce exactly, and what
 * keeps the behaviour identical no matter how the frames are paced.
 *
 * Three details are why this is its own module rather than a few lines in the
 * tick loop:
 *
 *  - **ARR 0 is a distinct path, not "a small number".** A charged DAS with
 *    ARR 0 slides to the wall inside the tick it fires.
 *  - **A blocked auto-shift parks its counter** one frame short of firing, so
 *    the shift happens the instant the obstruction clears rather than up to
 *    ARR frames later.
 *  - **The DAS charge survives a lock.** Holding a direction while a piece
 *    locks keeps moving the next piece immediately; DCD is the opt-in brake
 *    for players who find that too eager.
 *
 * The module does not touch the game. It reads key state and writes an
 * "intent"; `apply.js` turns that intent into game actions. That split is what
 * lets the whole input pipeline be tested in Node.
 *
 * Pure — no DOM, no `tiny`, no clock — so Node can test it.
 */

/**
 * Handling defaults. All four are player-editable in Phase 4.
 *
 *  - `das`  frames before auto-shift starts. 10 @ 60Hz ≈ 167ms.
 *  - `arr`  frames between auto-shifts. **0 means instant**, and takes the
 *           separate code path described above.
 *  - `sdf`  frames per soft-drop cell; `Infinity` drops to the floor in one
 *           tick. Note this is a *rate*, not TETR.IO's gravity multiplier —
 *           expressing it per-cell is what makes it directly implementable
 *           and testable, and `Infinity` is the behaviour players expect from
 *           "instant".
 *  - `dcd`  DAS cut delay: frames of dead time after a lock before a still-
 *           charged direction resumes. 0 = off, the default.
 */
export const DEFAULT_HANDLING = Object.freeze({
  das: 10,
  arr: 2,
  sdf: Infinity,
  dcd: 0,
});

/** Soft-drop intent codes. 0 none, 1 one cell, 2 straight to the floor. */
export const SOFT_DROP = { NONE: 0, ONE: 1, TO_FLOOR: 2 };

/**
 * One tick's worth of player intent.
 *
 * **This object is reused** — `tick()` clears and refills it, and always
 * returns the same instance for a given handling state. That is deliberate:
 * the tick and draw loops must not allocate. Read it before the next tick.
 */
export function makeIntent() {
  return {
    shift: 0,        // -1 left, 0 none, 1 right
    toWall: false,   // slide all the way in this one tick (ARR 0)
    softDrop: SOFT_DROP.NONE,
    rotateCW: false,
    rotateCCW: false,
    hardDrop: false,
    hold: false,
  };
}

/**
 * An input frame, as `input.js` produces it. Kept as a separate exported shape
 * so tests can build one without a DOM.
 *
 * `*Edge` flags are latched by the adapter and consumed here: a key pressed and
 * released between two ticks still counts as one press. Without that, a fast
 * tap would be silently dropped.
 */
export function makeInputFrame() {
  return {
    left: false,
    right: false,
    leftEdge: false,
    rightEdge: false,
    softDrop: false,
    cwEdge: false,
    ccwEdge: false,
    hardEdge: false,
    holdEdge: false,
  };
}

function normalizeConfig(config) {
  const c = config || {};
  const num = (v, fallback, min) => {
    const n = v === undefined ? fallback : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return n < min ? min : n;
  };
  return {
    das: num(c.das, DEFAULT_HANDLING.das, 0),
    arr: num(c.arr, DEFAULT_HANDLING.arr, 0),
    // `sdf` may legitimately be Infinity, so it is not run through `num`.
    sdf: c.sdf === undefined ? DEFAULT_HANDLING.sdf
      : (c.sdf === Infinity ? Infinity : Math.max(1, Number(c.sdf) || 1)),
    dcd: num(c.dcd, DEFAULT_HANDLING.dcd, 0),
  };
}

export function makeHandling(config) {
  return {
    cfg: normalizeConfig(config),
    dir: 0,          // direction currently being handled: -1, 0, 1
    mov: 0,          // frames since the last shift (or since the charge began)
    charged: false,  // DAS has expired; ARR now governs
    cut: 0,          // DCD frames of dead time remaining
    sdfTimer: 0,
    lastDir: 0,      // most recently pressed direction, for the both-held case
    intent: makeIntent(),
  };
}

/** Swap in new settings without losing the current charge. */
export function setHandling(h, config) {
  h.cfg = normalizeConfig(config);
  return h.cfg;
}

/**
 * The config as JSON-safe data.
 *
 * `sdf` defaults to `Infinity`, and JSON has no Infinity: `JSON.stringify` turns
 * it into `null`, which on the way back would mean *one cell per frame* rather
 * than instant. That is a silent behaviour change rather than an error, so the
 * encoding is explicit and lives in one place — both the settings file and the
 * replay header go through here.
 */
export function encodeHandling(config) {
  const c = normalizeConfig(config);
  return {
    das: c.das,
    arr: c.arr,
    sdf: c.sdf === Infinity ? null : c.sdf,
    dcd: c.dcd,
  };
}

/** The inverse of `encodeHandling`. Tolerates partial or missing data. */
export function decodeHandling(data) {
  const d = data || {};
  return normalizeConfig({
    das: d.das,
    arr: d.arr,
    sdf: d.sdf === null ? Infinity : d.sdf,
    dcd: d.dcd,
  });
}

function clearIntent(it) {
  it.shift = 0;
  it.toWall = false;
  it.softDrop = SOFT_DROP.NONE;
  it.rotateCW = false;
  it.rotateCCW = false;
  it.hardDrop = false;
  it.hold = false;
}

/* -------------------------------------------------------------------- tick */

/**
 * Advance the handling state by one tick and return the intent.
 *
 * The returned object is reused — see `makeIntent`.
 */
export function tick(h, input) {
  const it = h.intent;
  clearIntent(it);

  // One-shot actions. These are edges rather than held keys, so a tap that
  // began and ended inside this tick still registers.
  it.rotateCW = !!input.cwEdge;
  it.rotateCCW = !!input.ccwEdge;
  it.hardDrop = !!input.hardEdge;
  it.hold = !!input.holdEdge;

  tickShift(h, input, it);
  tickSoftDrop(h, input, it);

  // A hard drop supersedes a soft drop: the piece is about to be gone.
  if (it.hardDrop) it.softDrop = SOFT_DROP.NONE;

  // Consume every edge on the frame itself. The caller polls input once per
  // rendered frame but may run several ticks in that frame (catch-up after a
  // stall): held state should persist across all of them, while a one-shot
  // press — and a direction *press*, which restarts DAS — must happen once.
  // Consuming here rather than trusting the caller keeps that safe.
  input.leftEdge = false;
  input.rightEdge = false;
  input.cwEdge = false;
  input.ccwEdge = false;
  input.hardEdge = false;
  input.holdEdge = false;

  return it;
}

/**
 * Resolve which direction the player wants, then advance DAS/ARR.
 *
 * Direction policy: a fresh press always wins over a key that is merely still
 * held, so pressing right while left is down turns you around. Releasing it
 * falls back to the key still held. When both are held with no new press, the
 * more recently pressed one stays in charge.
 */
function tickShift(h, input, it) {
  const cfg = h.cfg;

  let want = 0;
  let edge = false;
  if (input.leftEdge || input.rightEdge) {
    if (input.leftEdge && input.rightEdge) want = h.lastDir || 1;
    else if (input.leftEdge) want = -1;
    else want = 1;
    edge = true;
    h.lastDir = want;
  } else if (input.left && input.right) {
    want = h.lastDir;
  } else if (input.left) {
    want = -1;
  } else if (input.right) {
    want = 1;
  }

  if (want === 0) {
    // Released: the charge is gone. Note this is the *only* thing that clears
    // it — a lock does not, which is the DAS-charging behaviour.
    h.dir = 0;
    h.mov = 0;
    h.charged = false;
    h.cut = 0;
    return;
  }

  // `edge` matters as well as the direction change: pressing a key, releasing
  // it and pressing it again inside one tick leaves `want === h.dir`, and that
  // tap must still shift.
  if (want !== h.dir || edge) {
    h.dir = want;
    h.mov = 0;
    h.charged = false;
    h.cut = 0;                 // a fresh press is never cut short
    it.shift = want;           // immediate shift on press
    return;
  }

  if (h.cut > 0) {
    // DCD: dead time. The counter does not advance either, so the cut is a
    // clean delay rather than a partial charge.
    h.cut--;
    return;
  }

  h.mov++;

  if (!h.charged) {
    if (h.mov >= cfg.das) {
      h.charged = true;
      h.mov = 0;
      it.shift = want;         // DAS expiry fires the first repeat
      // ARR governs the repeats, and the expiry tick *is* the first repeat —
      // so with ARR 0 it slides to the wall here, not one cell and then wait a
      // frame to slide. That frame is exactly where an instant-ARR player
      // would feel the input drop.
      if (cfg.arr === 0) it.toWall = true;
    }
    return;
  }

  if (cfg.arr === 0) {
    // Instant: slide to the wall. Fires every tick while charged; after the
    // first tick the piece is already at the wall and the move is a no-op.
    it.shift = want;
    it.toWall = true;
    return;
  }

  if (h.mov >= cfg.arr) {
    h.mov = 0;
    it.shift = want;
  }
}

function tickSoftDrop(h, input, it) {
  if (!input.softDrop) {
    h.sdfTimer = 0;
    return;
  }
  if (h.cfg.sdf === Infinity) {
    it.softDrop = SOFT_DROP.TO_FLOOR;
    return;
  }
  h.sdfTimer++;
  if (h.sdfTimer >= h.cfg.sdf) {
    h.sdfTimer = 0;
    it.softDrop = SOFT_DROP.ONE;
  }
}

/* -------------------------------------------------------------- callbacks */

/**
 * Tell the handling state that the shift it asked for was blocked.
 *
 * Parks the counter one frame short of the threshold, so the next tick retries
 * — and therefore moves the instant the obstruction clears. Without this, a
 * blocked shift would wait out a full ARR after clearing, which players feel
 * as a dropped input.
 *
 * Only meaningful once DAS has expired: while the charge is still running there
 * is nothing to park, and the charge continues normally.
 */
export function shiftBlocked(h) {
  if (!h.charged) return;
  if (h.cfg.arr === 0) return;   // already retried every tick
  h.mov = h.cfg.arr - 1;
}

/**
 * Tell the handling state that a piece just locked.
 *
 * Without DCD this deliberately does **not** reset `dir`, `mov` or `charged`:
 * that is what makes a held direction keep moving the next piece immediately,
 * and what makes DAS charge across a line clear.
 *
 * With DCD it does reset `mov`, because the cut is meant to be a *reliable*
 * delay. Leaving the ARR interval mid-cycle would make the real delay anywhere
 * from `dcd + 1` to `dcd + arr` depending on when the lock happened, which is
 * not something a player can build muscle memory on.
 */
export function onLock(h) {
  h.sdfTimer = 0;
  if (h.dir !== 0 && h.charged && h.cfg.dcd > 0) {
    h.cut = h.cfg.dcd;
    h.mov = 0;
  }
}

/**
 * Drop all state — for pause, blur, or a new game.
 *
 * Called when the window loses focus, because a `keyup` delivered to another
 * application never arrives here: without this, a piece would keep drifting
 * after a Cmd-Tab until the key was pressed and released again.
 */
export function resetHandling(h) {
  h.dir = 0;
  h.mov = 0;
  h.charged = false;
  h.cut = 0;
  h.sdfTimer = 0;
  h.lastDir = 0;
  clearIntent(h.intent);
}
