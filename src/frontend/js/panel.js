/**
 * The settings overlay — the only DOM beyond the canvas.
 *
 * Built from `settings.js`'s ranges rather than hand-written markup, so adding a
 * setting is a line of data. The panel is a DOM overlay rather than something
 * drawn on the canvas because real controls (sliders, a select) are a lot of
 * code to reimplement in Canvas 2D, and the game's key handling already ignores
 * events aimed at a form field.
 *
 * **Opening the panel pauses the game.** That is what makes the controls safe:
 * rather than teaching the input layer to ignore a focused button here and a
 * focused slider there, nothing is reading the keyboard while the panel is up.
 *
 * All styling lives in `style.css` — the CSP forbids inline `style` attributes,
 * so nothing here sets one.
 */

import { LIMITS, normalizeSettings } from './settings.js';
import { MODE_LIST, MODES } from './modes.js';
import { KEYMAP_IDS, keymapLabel } from './input.js';
import { el } from './dom.js';

/**
 * The sliders, in display order. `path` is where the value lives in the settings
 * object, so reading and writing are both mechanical.
 */
const CONTROLS = [
  {
    path: ['handling', 'das'],
    label: 'DAS',
    hint: 'hold this many frames before a direction auto-shifts',
  },
  {
    path: ['handling', 'arr'],
    hint: 'frames between auto-shifts — 0 slides to the wall in one tick',
    label: 'ARR',
  },
  {
    path: ['handling', 'dcd'],
    label: 'DCD',
    hint: 'pause after a lock before a held direction resumes — 0 is off',
  },
  {
    path: ['timing', 'are'],
    label: 'ARE',
    hint: 'frames before the next piece appears — 0 is the next tick',
  },
  {
    path: ['timing', 'lineClearDelay'],
    label: 'Clear',
    hint: 'frames the full rows stay up before they vanish',
  },
];

/**
 * Audio, in its own list rather than in CONTROLS.
 *
 * These are not handling: they do not change how the game plays, only how it
 * sounds. Keeping them separate is what lets `settingsToConfig` stay free of
 * them, so a volume slider can never become part of a replay.
 */
const AUDIO = [
  {
    path: ['volume'],
    label: 'Volume',
    hint: 'percent — 0 is silence without losing the level',
  },
];

function get(obj, path) {
  return path.reduce((o, k) => (o ? o[k] : undefined), obj);
}

function set(obj, path, value) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
  o[path[path.length - 1]] = value;
}

/**
 * Build the panel inside `root`.
 *
 * `onChange` fires on every slider movement, so a setting can be felt while
 * dragging it. `onCommit` fires when the control is released — that is the one
 * worth writing to disk, because a drag produces dozens of `input` events.
 */
export function makePanel(root, handlers) {
  const onChange = handlers.onChange || (() => {});
  const onCommit = handlers.onCommit || (() => {});
  const onClose = handlers.onClose || (() => {});

  let current = normalizeSettings(null);
  let open = false;
  const rows = [];

  /* -- mode -- */

  const modeRow = el('div', 'set-row');
  modeRow.appendChild(el('label', 'set-label', 'Mode'));
  const modeSelect = el('select', 'set-select');
  for (const id of MODE_LIST) {
    const opt = el('option', null, MODES[id].label + ' — ' + MODES[id].blurb);
    opt.value = id;
    modeSelect.appendChild(opt);
  }
  modeRow.appendChild(modeSelect);
  root.appendChild(modeRow);

  /* -- keymap, which is a choice between named maps rather than a value -- */

  const keymapRow = el('div', 'set-row');
  keymapRow.appendChild(el('label', 'set-label', 'Keymap'));
  const keymapSelect = el('select', 'set-select');
  for (const id of KEYMAP_IDS) {
    const opt = el('option', null, keymapLabel(id));
    opt.value = id;
    keymapSelect.appendChild(opt);
  }
  keymapRow.appendChild(keymapSelect);
  keymapRow.appendChild(el('p', 'set-hint', 'which keys move, rotate and hold'));
  root.appendChild(keymapRow);

  /* -- start level, which is per mode rather than global -- */

  const levelRow = el('div', 'set-row');
  levelRow.appendChild(el('label', 'set-label', 'Start level'));
  const levelRange = document.createElement('input');
  levelRange.type = 'range';
  levelRange.min = String(LIMITS.level.min);
  levelRange.max = String(LIMITS.level.max);
  levelRange.step = String(LIMITS.level.step);
  levelRange.className = 'set-range';
  levelRow.appendChild(levelRange);
  const levelOut = el('output', 'set-value', '');
  levelRow.appendChild(levelOut);
  levelRow.appendChild(el('p', 'set-hint',
    'how fast pieces fall — saved per mode, so Sprint can differ from Marathon'));
  root.appendChild(levelRow);

  levelRange.addEventListener('input', () => {
    current = readInto(current);
    levelOut.textContent = levelRange.value;
    onChange(current);
  });
  levelRange.addEventListener('change', () => {
    current = readInto(current);
    onCommit(current);
  });

  /* -- sliders -- */

  /**
   * One slider row, built from data.
   *
   * Factored out of the loop below so the audio section can use it too. The
   * file's own claim is that adding a setting is a line of data — and that only
   * holds if every section shares the machinery rather than growing its own copy.
   */
  function addSlider(c) {
    const range = LIMITS[c.path[c.path.length - 1]];
    const row = el('div', 'set-row');
    row.appendChild(el('label', 'set-label', c.label));

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.className = 'set-range';
    row.appendChild(input);

    const out = el('output', 'set-value', '');
    row.appendChild(out);

    row.appendChild(el('p', 'set-hint', c.hint));
    root.appendChild(row);

    rows.push({ c, input, out });

    input.addEventListener('input', () => {
      current = readInto(current);
      out.textContent = input.value;
      onChange(current);
    });
    input.addEventListener('change', () => {
      current = readInto(current);
      onCommit(current);
    });
  }

  for (const c of CONTROLS) addSlider(c);

  /* -- soft drop, which is the one control with a non-numeric option -- */

  const sdfRow = el('div', 'set-row');
  sdfRow.appendChild(el('label', 'set-label', 'SDF'));
  const sdfRange = document.createElement('input');
  sdfRange.type = 'range';
  sdfRange.min = String(LIMITS.sdf.min);
  sdfRange.max = String(LIMITS.sdf.max);
  sdfRange.step = String(LIMITS.sdf.step);
  sdfRange.className = 'set-range';
  sdfRow.appendChild(sdfRange);
  const sdfOut = el('output', 'set-value', '');
  sdfRow.appendChild(sdfOut);
  sdfRow.appendChild(el('p', 'set-hint', 'frames per soft-dropped cell, or instant'));

  const instantRow = el('div', 'set-row set-inline');
  const instant = document.createElement('input');
  instant.type = 'checkbox';
  instant.id = 'set-sdf-instant';
  const instantLabel = el('label', 'set-check', 'Instant soft drop');
  instantLabel.htmlFor = instant.id;
  instantRow.appendChild(instant);
  instantRow.appendChild(instantLabel);
  root.appendChild(sdfRow);
  root.appendChild(instantRow);

  sdfRange.addEventListener('input', () => {
    current = readInto(current);
    sdfOut.textContent = sdfRange.value;
    onChange(current);
  });
  sdfRange.addEventListener('change', () => {
    current = readInto(current);
    onCommit(current);
  });
  instant.addEventListener('change', () => {
    current = readInto(current);
    onCommit(current);
  });

  /* -- audio -- */

  for (const c of AUDIO) addSlider(c);

  const muteRow = el('div', 'set-row set-inline');
  const mute = document.createElement('input');
  mute.type = 'checkbox';
  mute.id = 'set-muted';
  const muteLabel = el('label', 'set-check', 'Mute all sound');
  muteLabel.htmlFor = mute.id;
  muteRow.appendChild(mute);
  muteRow.appendChild(muteLabel);
  root.appendChild(muteRow);

  mute.addEventListener('change', () => {
    current = readInto(current);
    onCommit(current);
  });

  /* -- actions -- */

  const actions = el('div', 'set-actions');
  const resetBtn = el('button', 'set-btn', 'Reset to defaults');
  resetBtn.type = 'button';
  resetBtn.addEventListener('click', () => {
    // Reset the sliders but keep the chosen mode, which is not a handling
    // preference — it is what you were playing.
    const keep = current.mode;
    const fresh = normalizeSettings(null);
    fresh.mode = keep;
    setSettings(fresh);
    onCommit(current);
  });
  const closeBtn = el('button', 'set-btn set-btn-primary', 'Close');
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', () => close());
  actions.appendChild(resetBtn);
  actions.appendChild(closeBtn);
  root.appendChild(actions);

  keymapSelect.addEventListener('change', () => {
    current = readInto(current);
    onCommit(current);
  });

  modeSelect.addEventListener('change', () => {
    current.mode = modeSelect.value;
    // Deliberately NOT `readInto` here: that reads the level slider into
    // `levels[modeSelect.value]`, and the select has already changed — so it
    // would write the outgoing mode's level onto the incoming one. Show the new
    // mode's stored level instead.
    levelRange.value = String(current.levels[current.mode]);
    levelOut.textContent = levelRange.value;
    onCommit(current);
  });

  /* -- reading and writing -- */

  /** Pull every control's value into `current` and return the clamped result. */
  function readInto(target) {
    for (const { c, input } of rows) {
      set(target, c.path, Number(input.value));
    }
    target.mode = modeSelect.value;
    target.levels[modeSelect.value] = Number(levelRange.value);
    target.handling.sdf = instant.checked ? null : Number(sdfRange.value);
    target.muted = mute.checked;
    target.keymap = keymapSelect.value;
    return normalizeSettings(target);
  }

  /** Push `settings` out to the controls. */
  function setSettings(settings) {
    current = normalizeSettings(settings);
    for (const { c, input, out } of rows) {
      const v = get(current, c.path);
      input.value = String(v);
      out.textContent = String(v);
    }
    const isInstant = current.handling.sdf === null;
    instant.checked = isInstant;
    sdfRange.disabled = isInstant;
    sdfRange.value = String(isInstant ? LIMITS.sdf.max : current.handling.sdf);
    sdfOut.textContent = isInstant ? 'instant' : String(current.handling.sdf);
    mute.checked = current.muted;
    keymapSelect.value = current.keymap;
    modeSelect.value = current.mode;
    levelRange.value = String(current.levels[current.mode]);
    levelOut.textContent = levelRange.value;
  }

  function setOpen(next) {
    open = next;
    root.classList.toggle('set-open', open);
  }

  function close() {
    setOpen(false);
    onClose();
  }

  // Escape closes, but only while the panel is up — the driver also uses Escape
  // to leave replay playback, and the two must not fight.
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });

  setSettings(normalizeSettings(null));
  setOpen(false);

  return {
    open() { setSettings(current); setOpen(true); },
    close,
    toggle() { if (open) close(); else this.open(); },
    isOpen() { return open; },
    set: setSettings,
    get() { return current; },
  };
}
