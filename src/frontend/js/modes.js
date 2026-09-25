/**
 * Game modes.
 *
 * A mode is a small data record, not a subclass — it says how the game starts,
 * how it levels, and what ends it. `game.js` reads these fields and never
 * branches on the mode's identity, which is what keeps a new mode a data change
 * rather than a code change.
 *
 * **Time limits are counted in ticks, not milliseconds.** The simulation must
 * not read a clock: a replay is a seed plus an input log, and it only reproduces
 * if the sim's behaviour depends solely on how many ticks have elapsed. So Ultra
 * is a tick budget, and the driver turns ticks into a clock for display. It also
 * means a time-limited run is exactly reproducible, which a wall-clock version
 * could never be.
 */

import { TICK_HZ } from './constants.js';

export const MODE = {
  MARATHON: 'marathon',
  SPRINT: 'sprint',
  ULTRA: 'ultra',
};

/** The order they appear in the menu. */
export const MODE_LIST = [MODE.MARATHON, MODE.SPRINT, MODE.ULTRA];

export const MODES = {
  marathon: {
    id: MODE.MARATHON,
    label: 'Marathon',
    blurb: '150 lines, level rises every 10',
    startLevel: 1,
    linesPerLevel: 10,
    goalLines: 150,
    timeLimitTicks: 0,
    showClock: false,
  },
  sprint: {
    id: MODE.SPRINT,
    label: 'Sprint',
    blurb: '40 lines, as fast as you can',
    /**
     * A fixed level, so the mode measures routing and speed rather than
     * survival. **4, not the 8 this started at.**
     *
     * Level 8 is 8 frames per cell — 2.5 s for a piece to fall the height of the
     * well, against 19 s at Marathon's level 1. That is 7.6x faster, and it makes
     * gravity the obstacle instead of the clock. The original reasoning was
     * backwards: a sprint should not fight the player, because the speed is
     * supposed to come from the player.
     *
     * Level 4 is 28 frames per cell, 8.9 s — enough that the mode has a
     * different character from Marathon, slow enough that a piece can be routed
     * deliberately. Adjustable per mode via `settings.levels`; see `levelForLines`.
     */
    startLevel: 4,
    linesPerLevel: 0,
    goalLines: 40,
    timeLimitTicks: 0,
    showClock: true,
  },
  ultra: {
    id: MODE.ULTRA,
    label: 'Ultra',
    blurb: '2 minutes, highest score wins',
    startLevel: 1,
    linesPerLevel: 10,
    goalLines: 0,
    timeLimitTicks: 120 * TICK_HZ,
    showClock: true,
  },
};

/** A mode by id, falling back to Marathon rather than throwing. */
export function modeConfig(id) {
  return MODES[id] || MODES[MODE.MARATHON];
}

/**
 * The level for a given line count.
 *
 * `startLevel` overrides the mode's own default. That is how a player's speed
 * preference reaches the simulation: a mode should not fight the player, and
 * how fast pieces fall is a preference rather than a rule.
 *
 * `linesPerLevel` of 0 means the level never changes, which is how Sprint holds
 * its fixed speed.
 */
export function levelForLines(mode, lines, startLevel) {
  const start = startLevel === undefined ? mode.startLevel : startLevel;
  if (!mode.linesPerLevel) return start;
  return start + Math.floor(lines / mode.linesPerLevel);
}

/** True when the run is over because the goal was met, not because of a top-out. */
export function goalReached(mode, lines, ticks) {
  if (mode.goalLines && lines >= mode.goalLines) return true;
  if (mode.timeLimitTicks && ticks >= mode.timeLimitTicks) return true;
  return false;
}

/**
 * Ticks as a clock, `m:ss.cc`. Counted from ticks rather than a wall clock so
 * the displayed time and the simulated time can never disagree.
 */
export function formatTicks(ticks) {
  const ms = ticks * (1000 / TICK_HZ);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return m + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

/**
 * Ticks as a plain duration, `m:ss` — no hundredths.
 *
 * The companion to `formatTicks`, and separate on purpose. A *measured* time wants
 * centiseconds: a Sprint result is decided by them. A mode's *goal* does not —
 * "2:00" is the round number the mode is built around, and writing "2:00.00"
 * claims a precision the goal does not have.
 */
export function formatDuration(ticks) {
  const ms = ticks * (1000 / TICK_HZ);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m + ':' + String(s).padStart(2, '0');
}

/** Ticks left on a time-limited mode, or 0 when there is no limit. */
export function ticksRemaining(mode, ticks) {
  if (!mode.timeLimitTicks) return 0;
  return Math.max(0, mode.timeLimitTicks - ticks);
}
