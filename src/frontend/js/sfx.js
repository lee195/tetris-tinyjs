/**
 * Which sound a tick should make, and how to play it.
 *
 * Split down the middle on purpose:
 *
 *  - `pick()` is **pure**. It reads the simulation and the intent and decides
 *    what, if anything, the player should hear. That is the part with all the
 *    judgement in it, and it is testable in Node.
 *  - `makeSfx()` is an adapter over **injected** bridge functions, so this file
 *    never mentions `tiny` and the adapter can be tested with fakes. The same
 *    shape as `handling.js` taking its config as an argument rather than
 *    reading `tiny.store` — which is what made the input path testable.
 *
 * ## Why the driver decides instead of the simulation announcing
 *
 * The simulation stays untouched, so the replay contract is untouched with it.
 * Everything needed is already observable from outside a `step()`, but only if
 * the right signals are used — and two of the obvious ones are wrong:
 *
 *  - **The lock is not `piece === -1`.** With ARE 0 the next piece spawns on the
 *    same tick as the lock, so that marker is never visible from outside a
 *    `step()`. `lockCurrent` assigns `lastClear` to a fresh object on *every*
 *    lock, clear or not, so its identity is the reliable signal — and it carries
 *    the clear, T-spin, back-to-back and combo along with it.
 *  - **Actions are read from the intent, not inferred from the state.** A rotate
 *    followed by a shift in one tick leaves `lastAction` as 'move'; a hold
 *    followed by a lock-and-spawn has `holdUsed` reset before anyone can look.
 *    `apply.js` records what actually landed.
 */

import { SFX_NAMES } from './sfxgen.js';

/**
 * The names this module can return. Every value must exist in `SFX_NAMES` — the
 * sampler *rejects* on an unknown name rather than playing nothing, so a rename
 * that drifted these two apart would turn every event into a rejected promise.
 * `test/sfx.test.mjs` pins that they agree.
 */
export const SFX = Object.freeze({
  LOCK: 'lock',
  ROTATE: 'rotate',
  CLEAR: 'clear',
  TSPIN: 'tspin',
  HOLD: 'hold',
  HARD_DROP: 'harddrop',
  LEVEL_UP: 'levelup',
  OVER: 'over',
  UI: 'ui',
});

/** The status a run is over in, compared as a string so this module stays free of the sim. */
const OVER = 'over';

/**
 * Per-tick scratch state for `pick`.
 *
 * `lastClear` holds the previous tick's `lastClear` **object**, compared by
 * identity — the same trick the banner uses, and for the same reason: the
 * alternative is a tick stamp inside the simulation, which is presentation
 * state and does not belong there.
 *
 * The driver keeps its own copy for the banner. They are deliberately not
 * shared: the banner tracks a lifetime (how long a callout stays up) and this
 * tracks a single edge, and coupling them would make either one harder to
 * change.
 */
export function makeSfxState() {
  return { level: 1, lines: 0, status: '', lastClear: null };
}

/**
 * Forget the previous run's observations.
 *
 * Called when a new game starts. Without it the first tick of a new run compares
 * against the *old* run's level and line count — so choosing a mode whose speed
 * is higher than the last one would open the game with a level-up sound.
 */
export function resetSfxState(sfx) {
  sfx.level = 1;
  sfx.lines = 0;
  sfx.status = '';
  sfx.lastClear = null;
}

/**
 * Decide what this tick should sound like.
 *
 * **One sound per tick, chosen by significance.** Several events genuinely do
 * collide: with the default zero line-clear delay, a hard drop that clears lines
 * and crosses a level boundary produces a lock, a clear and a level-up inside a
 * single tick — the clear and the level-up both happen in `tickClearing`, one
 * tick at most after the lock. Two sounds 16 ms apart do not arrive as two
 * sounds, so layering them would only make the mix muddier at exactly the moment
 * the player wants to hear what they did.
 *
 * The order below is therefore a judgement, and the reasoning is worth keeping:
 * a clear outranks a level-up because the clear is the direct consequence of the
 * player's own action while the level is continuously visible in the panel; a
 * hard drop outranks a plain lock because it is the more informative of the two
 * impacts and the player chose it.
 *
 * Returns `{ name, rate, cut }` or null. `rate` is a playback-rate multiplier
 * (pitch and speed together) used to keep a small bank from sounding repetitive;
 * `cut` asks the caller to stop everything already playing first, which only the
 * end of a run wants.
 *
 * Mutates `sfx`, which is per-driver scratch — not shared, not reentrant.
 */
export function pick(sfx, game, it) {
  const prevLevel = sfx.level;
  const prevLines = sfx.lines;
  const prevStatus = sfx.status;
  const prevClear = sfx.lastClear;

  sfx.level = game.level;
  sfx.lines = game.lines;
  sfx.status = game.status;
  sfx.lastClear = game.lastClear;

  // The end of the run, on the transition only. Firing on the *state* would
  // re-fire on every later tick, and although the driver breaks its tick loop
  // once a run is over, a function that only works because of its caller's loop
  // is a trap for whoever changes the loop.
  if (game.status === OVER && prevStatus !== OVER) {
    return { name: SFX.OVER, rate: 1, cut: true };
  }
  if (game.status === OVER) return null;

  // A lock, carrying its own outcome. `lastClear` is a fresh object per lock, so
  // this is one comparison for four different things.
  if (game.lastClear && game.lastClear !== prevClear) {
    const c = game.lastClear;
    const combo = c.combo > 0 ? c.combo : 0;
    if (c.tspin) return { name: SFX.TSPIN, rate: pitch(combo, 0.03), cut: false };
    if (c.lines > 0) return { name: SFX.CLEAR, rate: pitch(combo, 0.04), cut: false };
    // A lock with no clear still happened, and it is the commonest event in the
    // game — the level is folded in so a faster game sounds heavier.
    return { name: SFX.LOCK, rate: 1 - Math.min(game.level, 15) * 0.012, cut: false };
  }

  // Gated on the line count as well as the level, and the line count is the
  // part that matters. `setStartLevel` moves `game.level` too, and `applyLive`
  // calls it on every settings change — so dragging the "Start level" slider
  // would otherwise play a level-up on the first tick after the panel closes.
  // Inside a tick, the only thing that moves the level is the curve in
  // `tickClearing`, which runs after a clear, so a rising line count is exactly
  // the condition.
  if (game.level > prevLevel && game.lines > prevLines) {
    return { name: SFX.LEVEL_UP, rate: 1, cut: false };
  }

  // Actions. Read from the intent rather than inferred — see the note at the top.
  if (it && it.didHardDrop) return { name: SFX.HARD_DROP, rate: 1, cut: false };
  if (it && it.didHold) return { name: SFX.HOLD, rate: 1, cut: false };
  if (it && it.didRotate) return { name: SFX.ROTATE, rate: 1, cut: false };

  return null;
}

/** Pitch rises with the combo, bounded so a long chain cannot run away. */
function pitch(combo, step) {
  return 1 + Math.min(combo, 8) * step;
}

/**
 * A UI sound, for the menu. Not a simulation event, so it is not `pick`'s job.
 */
export function uiSound() {
  return { name: SFX.UI, rate: 1, cut: false };
}

/**
 * The sampler, behind injected functions.
 *
 * `bridge` is `{ load, play, master, stopAll, onError }`. Nothing here is
 * awaited by the frame loop: `play` resolves when the bridge call completes, not
 * when the sound finishes, and a sound effect that blocks a frame is worse than
 * a sound effect that is late.
 */
export function makeSfx(bridge) {
  let volume = 1;
  let muted = false;
  let ready = false;

  return {
    /**
     * Load the whole bank. Called once at startup, and deliberately not awaited
     * by the frame loop.
     *
     * A failure is reported and then *ignored* rather than propagated: a machine
     * where the sampler cannot start should still play the game, silently. The
     * alternative — a boot that refuses to continue because a beep did not load
     * — trades the whole game for a sound effect.
     *
     * Readiness is all-or-nothing. A partial bank would play some events and
     * drop others, which is worse than no sound: silence is obviously broken,
     * while a missing line-clear sound just looks like the game not noticing.
     */
    async loadBank(entries) {
      try {
        const r = await bridge.load(entries);
        const loaded = r && typeof r.loaded === 'number' ? r.loaded : 0;
        ready = loaded === entries.length && !(r && r.failed);
        if (!ready) {
          bridge.onError('sfx: bank incomplete (' + loaded + '/' + entries.length + ')' +
            (r && r.failed ? ' — ' + r.failed : ''));
        }
        return ready;
      } catch (err) {
        bridge.onError('sfx: bank load failed: ' + message(err));
        ready = false;
        return false;
      }
    },

    /** Fire one decision from `pick`, or nothing for null. */
    fire(decision) {
      if (!decision || !ready) return;
      if (decision.cut) bridge.stopAll();
      // `Promise.resolve` around the call so a bridge that returns a plain value
      // rather than a promise cannot throw here — `fire` runs inside the tick
      // loop, and a throw would take the frame with it.
      Promise.resolve(bridge.play(decision.name, {
        vol: muted ? 0 : volume,
        rate: decision.rate,
      })).catch((err) => bridge.onError('sfx: play failed: ' + message(err)));
    },

    /** 0..1. Applied through the mixer's master gain, not per voice. */
    setVolume(v) {
      volume = v;
      bridge.master(muted ? 0 : volume);
    },

    setMuted(next) {
      muted = !!next;
      bridge.master(muted ? 0 : volume);
    },

    isReady() {
      return ready;
    },
  };
}

function message(err) {
  return err && err.message ? err.message : String(err);
}

/** Every name `pick` can return must be renderable. Used by the tests. */
export function sfxNamesAgree() {
  const known = new Set(SFX_NAMES);
  const bad = [];
  for (const key of Object.keys(SFX)) if (!known.has(SFX[key])) bad.push(SFX[key]);
  return bad;
}
