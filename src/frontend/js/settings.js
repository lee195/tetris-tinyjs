/**
 * Player settings: what persists between runs.
 *
 * Pure — no DOM, no `tiny` — so the clamping and the defaults are testable. The
 * DOM panel that edits these lives in `panel.js`; the simulation never reads a
 * settings object directly, it reads the config this module produces.
 *
 * Everything is clamped to a sane range on the way in *and* on the way out. The
 * file on disk is user-editable and may be from an older build, so a value that
 * is out of range, the wrong type or missing entirely has to degrade to the
 * default rather than reach the simulation. A NaN DAS would otherwise stall the
 * input layer in a way that looks like a hung game.
 */

import { encodeHandling, decodeHandling, DEFAULT_HANDLING } from './handling.js';
import { ARE_DEFAULT, LINE_CLEAR_DELAY_DEFAULT } from './rules.js';
import { MODE, MODES } from './modes.js';

/** Bump when the shape changes in a way that needs migrating. */
export const SETTINGS_VERSION = 1;

/**
 * Ranges for the numeric settings, and the panel's slider bounds.
 *
 * `arr` and `are` both go down to 0, which is meaningful rather than a floor:
 * ARR 0 is the instant-shift path and ARE 0 is the minimum spawn delay.
 */
export const LIMITS = Object.freeze({
  das: { min: 0, max: 30, step: 1 },
  arr: { min: 0, max: 10, step: 1 },
  dcd: { min: 0, max: 30, step: 1 },
  are: { min: 0, max: 30, step: 1 },
  lineClearDelay: { min: 0, max: 60, step: 1 },
  sdf: { min: 1, max: 60, step: 1 },
});

export const DEFAULT_SETTINGS = Object.freeze({
  v: SETTINGS_VERSION,
  mode: MODE.MARATHON,
  handling: {
    das: DEFAULT_HANDLING.das,
    arr: DEFAULT_HANDLING.arr,
    // null means instant, matching the JSON encoding in `encodeHandling`.
    sdf: null,
    dcd: DEFAULT_HANDLING.dcd,
  },
  timing: {
    are: ARE_DEFAULT,
    lineClearDelay: LINE_CLEAR_DELAY_DEFAULT,
  },
});

function clamp(value, range, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const r = Math.round(n);
  if (r < range.min) return range.min;
  if (r > range.max) return range.max;
  return r;
}

/**
 * Coerce anything into a usable settings object.
 *
 * Never throws. A corrupt or half-written settings file must leave the game
 * playable with defaults, not unlaunchable.
 */
export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const h = r.handling && typeof r.handling === 'object' ? r.handling : {};
  const t = r.timing && typeof r.timing === 'object' ? r.timing : {};
  const d = DEFAULT_SETTINGS;

  return {
    v: SETTINGS_VERSION,
    mode: typeof r.mode === 'string' && MODES[r.mode] ? r.mode : d.mode,
    handling: {
      das: clamp(h.das, LIMITS.das, d.handling.das),
      arr: clamp(h.arr, LIMITS.arr, d.handling.arr),
      // null is meaningful — it is instant — so it is preserved rather than
      // clamped, and anything unusable falls back to it.
      sdf: (h.sdf === null || h.sdf === undefined)
        ? d.handling.sdf
        : clamp(h.sdf, LIMITS.sdf, d.handling.sdf),
      dcd: clamp(h.dcd, LIMITS.dcd, d.handling.dcd),
    },
    timing: {
      are: clamp(t.are, LIMITS.are, d.timing.are),
      lineClearDelay: clamp(t.lineClearDelay, LIMITS.lineClearDelay, d.timing.lineClearDelay),
    },
  };
}

/**
 * What the simulation needs: a mode id, a handling config with a real
 * `Infinity` in it, and the two game timings.
 */
export function settingsToConfig(settings) {
  const n = normalizeSettings(settings);
  return {
    mode: n.mode,
    handling: decodeHandling(n.handling),
    timing: { are: n.timing.are, lineClearDelay: n.timing.lineClearDelay },
  };
}

/**
 * Capture the current state as settings, ready to save.
 *
 * Takes the game as well as the handling config because ARE and the line-clear
 * delay live on the game state — they are game rules, not input policy.
 */
export function captureSettings(mode, handlingCfg, game) {
  return normalizeSettings({
    mode,
    handling: encodeHandling(handlingCfg),
    timing: { are: game.are, lineClearDelay: game.lineClearDelay },
  });
}

/** True when two settings objects are equivalent — used to skip a needless save. */
export function settingsEqual(a, b) {
  const x = normalizeSettings(a);
  const y = normalizeSettings(b);
  return x.mode === y.mode
    && x.handling.das === y.handling.das
    && x.handling.arr === y.handling.arr
    && x.handling.sdf === y.handling.sdf
    && x.handling.dcd === y.handling.dcd
    && x.timing.are === y.timing.are
    && x.timing.lineClearDelay === y.timing.lineClearDelay;
}
