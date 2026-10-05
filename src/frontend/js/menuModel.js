/**
 * The title screen's data and its decisions. Pure.
 *
 * The menu is DOM, so the bench cannot pixel-check it the way it checks the
 * canvas — which is exactly why the parts worth getting right live here, where
 * Node can test them. `menu.js` is left with nothing but element construction and
 * event wiring, the same split as `settings.js` against `panel.js`.
 */

import { MODES, MODE_LIST, formatTicks, formatDuration } from './modes.js';

/** What a row does when it is chosen. */
export const ITEM = { MODE: 'mode', REPLAYS: 'replays', SETTINGS: 'settings' };

/** How many score rows the title screen shows before it stops. */
export const SCORE_ROWS = 5;

/**
 * The rows, in display order: one per mode, then Replays, then Settings.
 *
 * Built from `MODE_LIST` rather than hardcoded, so adding a mode to `modes.js`
 * puts it on the title screen without touching this file — the same reason the
 * settings panel builds its sliders from data.
 */
export function buildItems() {
  const out = [];
  for (const id of MODE_LIST) {
    const mode = MODES[id];
    out.push({
      kind: ITEM.MODE,
      id,
      label: mode.label,
      blurb: mode.blurb,
      goal: goalText(mode),
    });
  }
  out.push({
    kind: ITEM.REPLAYS,
    id: ITEM.REPLAYS,
    label: 'Replays',
    blurb: 'watch a saved run',
    goal: '',
  });
  out.push({
    kind: ITEM.SETTINGS,
    id: ITEM.SETTINGS,
    label: 'Settings',
    blurb: 'handling, timing and sound',
    goal: '',
  });
  return out;
}

/**
 * What a mode asks of you, in as few words as possible.
 *
 * Both a line goal and a clock are handled even though no mode has both today,
 * because the alternative is a `goalText` that silently drops half the answer
 * when one is added.
 */
export function goalText(mode) {
  if (!mode) return '';
  const lines = mode.goalLines ? mode.goalLines + ' lines' : '';
  // A goal, so `formatDuration` rather than `formatTicks` — see the note there.
  const time = mode.timeLimitTicks ? formatDuration(mode.timeLimitTicks) : '';
  if (lines && time) return lines + ' in ' + time;
  return lines || time;
}

/**
 * The best score recorded for a mode, or 0 when there is none.
 *
 * Moved here from the driver, where it was a private helper: it is a pure
 * question about the score table, so it belongs somewhere it can be tested.
 */
export function bestFor(scoreTable, modeId) {
  let best = 0;
  if (!Array.isArray(scoreTable)) return 0;
  for (const e of scoreTable) {
    if (e && e.mode === modeId && e.score > best) best = e.score;
  }
  return best;
}

/**
 * The score rows for one mode, best first.
 *
 * The backend already returns the table sorted best-first, and filtering
 * preserves that order — but this sorts anyway. It is cheap, and it makes the
 * function correct on its own terms rather than on a promise made by its caller,
 * which is the kind of coupling that breaks quietly when the caller changes.
 */
export function scoreRows(scoreTable, modeId, limit) {
  const rows = [];
  if (!Array.isArray(scoreTable)) return rows;
  for (const e of scoreTable) if (e && e.mode === modeId) rows.push(e);
  rows.sort((a, b) => (b.score - a.score) || (b.date - a.date));

  const max = limit === undefined ? rows.length : Math.min(limit, rows.length);
  const out = [];
  for (let i = 0; i < max; i++) {
    const e = rows[i];
    out.push({
      rank: i + 1,
      score: e.score,
      lines: e.lines,
      time: formatTicks(e.ticks),
      reason: e.reason,
    });
  }
  return out;
}

/**
 * A timestamp as `YYYY-MM-DD HH:MM`, local time.
 *
 * Built from the `Date` getters rather than `toLocaleString`, so the picker reads
 * the same on every machine and the test does not depend on the system locale.
 */
export function formatWhen(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/**
 * The replay picker's rows, newest first.
 *
 * The backend keeps its index sorted best-score-first, because that is what it
 * prunes by — so the order here has to be imposed, not inherited. Ties on the
 * date fall back to the id so the order is stable between two fetches.
 */
export function replayRows(list) {
  if (!Array.isArray(list)) return [];
  const rows = list.filter((e) => e && typeof e.id === 'string');
  rows.sort((a, b) => ((b.date || 0) - (a.date || 0)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return rows.map((e) => ({
    id: e.id,
    modeId: String(e.mode || ''),
    when: formatWhen(e.date),
    mode: MODES[e.mode] ? MODES[e.mode].label : String(e.mode || ''),
    score: e.score || 0,
    lines: e.lines || 0,
    time: formatTicks(e.ticks || 0),
    reason: e.reason || '',
  }));
}

/** The filter that shows every replay. Also the picker's default. */
export const ALL_MODES = 'all';

/**
 * The picker's mode filters, in the order left/right steps through them: All,
 * then one per mode. From `MODE_LIST`, like `buildItems`, so a new mode gets a
 * filter without anyone editing this.
 */
export function replayFilters() {
  const out = [{ id: ALL_MODES, label: 'All' }];
  for (const id of MODE_LIST) out.push({ id, label: MODES[id].label });
  return out;
}

/** The replay rows one filter keeps, in the order they came in. */
export function filterReplays(rows, filterId) {
  if (!Array.isArray(rows)) return [];
  if (!filterId || filterId === ALL_MODES) return rows.slice();
  return rows.filter((r) => r && r.modeId === filterId);
}

/**
 * Move a selection index by `delta`, wrapping at both ends.
 *
 * Wrapping rather than clamping, because a four-row menu that stops dead at the
 * bottom feels broken; and the double modulo is what makes a negative delta from
 * index 0 land on the last row rather than at -1.
 */
export function moveSelection(index, delta, count) {
  if (!(count > 0)) return 0;
  return ((index + delta) % count + count) % count;
}

/**
 * A key code to a menu action, or null for a key the menu does not own.
 *
 * `event.code`, not `event.key` — physical keys, so the layout does not change
 * the controls, matching `input.js`.
 */
const KEYS = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  KeyW: 'up',
  KeyS: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyA: 'left',
  KeyD: 'right',
  Enter: 'start',
  NumpadEnter: 'start',
  Space: 'start',
  Escape: 'close',
};

export function keyToAction(code) {
  return KEYS[code] || null;
}

/**
 * A key code to an answer in the quit confirmation, or null.
 *
 * Separate from `keyToAction` because the confirm is a different mode with its
 * own keys, and folding them in would make `Escape` mean two things at once.
 * `Enter`/`Y` quit and `Escape`/`N` cancel — the letters are aliases so the
 * prompt works without moving a hand to the arrows.
 */
const CONFIRM_KEYS = {
  Enter: 'yes',
  NumpadEnter: 'yes',
  KeyY: 'yes',
  Escape: 'no',
  KeyN: 'no',
};

export function confirmKey(code) {
  return CONFIRM_KEYS[code] || null;
}

/** The row a selection index points at, or null. */
export function itemAt(items, index) {
  if (!Array.isArray(items) || index < 0 || index >= items.length) return null;
  return items[index];
}

/** The mode id a selection points at, or null when it points at a non-mode row. */
export function modeAt(items, index) {
  const item = itemAt(items, index);
  return item && item.kind === ITEM.MODE ? item.id : null;
}
