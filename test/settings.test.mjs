/**
 * Headless tests for settings: defaults, clamping, and the JSON round trip.
 *
 *   node test/settings.test.mjs
 *
 * The round trip is the part worth being careful about. `sdf` defaults to
 * `Infinity`, JSON has no Infinity, and the value that comes back instead —
 * `null` — is one `Number()` call away from meaning *one cell per frame*. That
 * is not an error, it is a silent behaviour change: soft drop would become slow
 * and nothing would say why.
 *
 * The clamping matters for the same reason. The settings file is on disk, is
 * user-editable, and may have been written by an older build, so every value has
 * to degrade to something sane rather than reach the simulation. A NaN DAS
 * stalls the input layer in a way that looks like a hung game.
 */

import {
  DEFAULT_SETTINGS, LIMITS, SETTINGS_VERSION, normalizeSettings,
  settingsToConfig, captureSettings, settingsEqual,
} from '../src/frontend/js/settings.js';
import { encodeHandling, decodeHandling, DEFAULT_HANDLING } from '../src/frontend/js/handling.js';
import { ARE_DEFAULT, LINE_CLEAR_DELAY_DEFAULT } from '../src/frontend/js/rules.js';
import { MODE, MODES, MODE_LIST } from '../src/frontend/js/modes.js';
import { ok, eq, group, done } from './harness.mjs';

/* ---------------------------------------------------------------- defaults */

group('defaults');

{
  const d = normalizeSettings(null);
  eq(d.mode, MODE.MARATHON, 'the default mode is marathon');
  eq(d.handling.das, DEFAULT_HANDLING.das, 'DAS defaults to the handling default');
  eq(d.handling.arr, DEFAULT_HANDLING.arr, 'and so does ARR');
  eq(d.handling.sdf, null, 'SDF defaults to null, meaning instant');
  eq(d.timing.are, ARE_DEFAULT, 'ARE defaults to 0');
  eq(d.timing.lineClearDelay, LINE_CLEAR_DELAY_DEFAULT, 'and so does the line-clear delay');
  eq(d.v, SETTINGS_VERSION, 'and the version is stamped');

  ok(settingsEqual(null, DEFAULT_SETTINGS), 'null and the defaults are equivalent');
  ok(settingsEqual(undefined, {}), 'and so are undefined and an empty object');
}

/* ---------------------------------------------------------------- clamping */

group('clamping');

{
  const d = normalizeSettings(null);

  // Out of range clamps to the bound rather than to the default — a player who
  // dragged a slider past the end meant the end.
  const high = normalizeSettings({
    handling: { das: 999, arr: 999, dcd: 999, sdf: 999 },
    timing: { are: 999, lineClearDelay: 999 },
  });
  eq(high.handling.das, LIMITS.das.max, 'a huge DAS clamps to the maximum');
  eq(high.handling.arr, LIMITS.arr.max, 'and so does ARR');
  eq(high.handling.sdf, LIMITS.sdf.max, 'and SDF');
  eq(high.timing.are, LIMITS.are.max, 'and ARE');
  eq(high.timing.lineClearDelay, LIMITS.lineClearDelay.max, 'and the line-clear delay');

  const low = normalizeSettings({
    handling: { das: -50, arr: -50, dcd: -50, sdf: -50 },
    timing: { are: -50, lineClearDelay: -50 },
  });
  eq(low.handling.das, 0, 'a negative DAS clamps to 0');
  eq(low.handling.arr, 0, 'a negative ARR clamps to 0, which is meaningful');
  eq(low.timing.are, 0, 'a negative ARE clamps to 0');
  eq(low.handling.sdf, LIMITS.sdf.min, 'a negative SDF clamps to the minimum');
  eq(low.handling.dcd, 0, 'a negative DCD clamps to 0');

  // Unusable values fall back to the default rather than propagating.
  const junk = normalizeSettings({
    handling: { das: 'fast', arr: NaN, sdf: {}, dcd: Infinity },
    timing: { are: 'x', lineClearDelay: null },
  });
  eq(junk.handling.das, d.handling.das, 'a non-numeric DAS falls back to the default');
  eq(junk.handling.arr, d.handling.arr, 'a NaN ARR falls back');
  eq(junk.handling.sdf, null, 'an object SDF falls back to instant');
  eq(junk.handling.dcd, d.handling.dcd, 'an infinite DCD falls back');
  eq(junk.timing.are, d.timing.are, 'a string ARE falls back');
  eq(junk.timing.lineClearDelay, 0, 'a null line-clear delay clamps to 0');

  // Fractions are rounded: the counters are whole ticks.
  const frac = normalizeSettings({ handling: { das: 7.6 } });
  eq(frac.handling.das, 8, 'a fractional DAS rounds to a whole tick');
}

{
  // A malformed shape at any level must not throw.
  const shapes = [null, undefined, 0, 'nope', [], { handling: 'x' }, { timing: 5 }];
  let allOk = true;
  for (const s of shapes) {
    try {
      const n = normalizeSettings(s);
      if (n.mode !== MODE.MARATHON || n.handling.das !== DEFAULT_HANDLING.das) allOk = false;
    } catch (err) {
      allOk = false;
    }
  }
  ok(allOk, 'every malformed shape normalizes to the defaults without throwing');
}

{
  const modes = normalizeSettings({ mode: 'nonsense' });
  eq(modes.mode, MODE.MARATHON, 'an unknown mode falls back to marathon');
  eq(normalizeSettings({ mode: 'sprint' }).mode, MODE.SPRINT, 'a known one is kept');
}

/* --------------------------------------------------------- the JSON round trip */

group('the Infinity round trip');

{
  // This is the trap: Infinity -> JSON -> null, and null is one Number() call
  // away from meaning "one cell per frame".
  const encoded = encodeHandling({ das: 4, arr: 1, sdf: Infinity, dcd: 0 });
  eq(encoded.sdf, null, 'Infinity encodes as null');
  ok(encoded.sdf !== undefined, 'and the key is present');

  const throughJson = JSON.parse(JSON.stringify(encoded));
  eq(decodeHandling(throughJson).sdf, Infinity, 'and decodes back to Infinity');

  // The failure mode, stated as an assertion: decoding must NOT produce 1.
  ok(decodeHandling({ sdf: null }).sdf !== 1,
    'null must not decode as one cell per frame');

  eq(decodeHandling({ sdf: 3 }).sdf, 3, 'a finite SDF survives untouched');
  eq(decodeHandling({}).sdf, Infinity, 'a missing SDF means instant');
  eq(decodeHandling(null).sdf, Infinity, 'and so does a missing config');
}

{
  // The whole settings object through the persistence path.
  const original = normalizeSettings({
    mode: 'sprint',
    handling: { das: 3, arr: 0, sdf: null, dcd: 2 },
    timing: { are: 1, lineClearDelay: 4 },
  });

  const onDisk = JSON.parse(JSON.stringify(original));
  const restored = normalizeSettings(onDisk);
  ok(settingsEqual(original, restored), 'settings survive a JSON round trip unchanged');

  const before = settingsToConfig(original);
  const after = settingsToConfig(restored);
  eq(after.mode, before.mode, 'the mode survives');
  eq(after.handling.das, 3, 'DAS survives');
  eq(after.handling.arr, 0, 'ARR 0 survives as 0, not as a default');
  eq(after.handling.sdf, Infinity, 'SDF survives as instant');
  eq(after.handling.dcd, 2, 'DCD survives');
  eq(after.timing.are, 1, 'ARE survives');
  eq(after.timing.lineClearDelay, 4, 'and the line-clear delay');
}

/* ------------------------------------------------------------ per-mode speed */

group('the per-mode speed');

{
  const d = normalizeSettings(null);
  for (const id of MODE_LIST) {
    eq(d.levels[id], MODES[id].startLevel, 'the default speed for ' + id + ' is the mode default');
  }

  // Clamped like everything else.
  eq(normalizeSettings({ levels: { sprint: 999 } }).levels.sprint, LIMITS.level.max,
    'a huge speed clamps to the maximum');
  eq(normalizeSettings({ levels: { sprint: -3 } }).levels.sprint, LIMITS.level.min,
    'and a negative one to the minimum');
  eq(normalizeSettings({ levels: { sprint: 'fast' } }).levels.sprint, MODES.sprint.startLevel,
    'junk falls back to the mode default');

  // A partial map still produces every mode, so nothing downstream has to guard
  // for a missing entry.
  const partial = normalizeSettings({ levels: { marathon: 5 } });
  eq(partial.levels.marathon, 5, 'a supplied mode is kept');
  eq(partial.levels.sprint, MODES.sprint.startLevel, 'and the others are filled in');
  ok(typeof partial.levels.ultra === 'number', 'every mode has a number');

  // Through JSON, which is how it reaches disk.
  const original = normalizeSettings({ mode: 'sprint', levels: { sprint: 9, marathon: 2 } });
  const restored = normalizeSettings(JSON.parse(JSON.stringify(original)));
  eq(restored.levels.sprint, 9, 'speeds survive a JSON round trip');
  eq(restored.levels.marathon, 2, 'including the ones not being played');
  ok(settingsEqual(original, restored), 'and equivalent speeds compare equal');
  ok(!settingsEqual(original, normalizeSettings({ mode: 'sprint', levels: { sprint: 8 } })),
    'while a different speed is not equal');
}

/* ------------------------------------------------------- settingsToConfig */

group('settings to config');

{
  // The config carries the *running* mode's speed, which is what the simulation
  // needs — it does not care what the other modes are set to.
  eq(settingsToConfig({ mode: 'sprint', levels: { sprint: 7 } }).startLevel, 7,
    'the config carries the running mode\'s speed');
  eq(settingsToConfig({ mode: 'ultra' }).startLevel, DEFAULT_SETTINGS.levels.ultra,
    'and the default when none was chosen');
}

{
  const cfg = settingsToConfig({
    mode: 'ultra',
    handling: { das: 8, arr: 2, sdf: 5, dcd: 1 },
    timing: { are: 0, lineClearDelay: 0 },
  });
  eq(cfg.mode, 'ultra', 'the mode is passed through');
  eq(cfg.handling.sdf, 5, 'a finite SDF stays finite');
  eq(cfg.timing.are, 0, 'ARE 0 is preserved, not treated as missing');
  ok(typeof cfg.handling.das === 'number', 'the config is plain data');

  const instant = settingsToConfig({ handling: { sdf: null } });
  eq(instant.handling.sdf, Infinity, 'null becomes a real Infinity for the sim');

  // settingsToConfig must be safe on garbage, because it runs at startup on
  // whatever was on disk.
  const fromJunk = settingsToConfig('not a settings object');
  eq(fromJunk.mode, MODE.MARATHON, 'garbage yields the default mode');
  eq(fromJunk.handling.sdf, Infinity, 'and the default handling');
}

/* -------------------------------------------------------- captureSettings */

group('capturing the live state');

{
  // The game state is where the speed, ARE and the line-clear delay live, so
  // capturing has to take the game as well as the handling config.
  const fakeGame = { startLevel: 6, are: 3, lineClearDelay: 7 };
  const captured = captureSettings(
    { mode: 'sprint', levels: { marathon: 2 } },
    { das: 2, arr: 0, sdf: 9, dcd: 0 },
    fakeGame);

  eq(captured.mode, 'sprint', 'the mode is captured');
  eq(captured.handling.das, 2, 'the handling config is captured');
  eq(captured.timing.are, 3, 'ARE comes from the game state');
  eq(captured.timing.lineClearDelay, 7, 'and so does the line-clear delay');
  eq(captured.levels.sprint, 6, 'the speed comes from the game state');
  // The reason capture takes the whole settings object rather than just a mode:
  // rebuilding from scratch would reset every *other* mode's speed to its
  // default, so finishing a Sprint run would quietly undo a Marathon tweak.
  eq(captured.levels.marathon, 2, 'and the other modes keep their own speeds');
  eq(captured.levels.ultra, DEFAULT_SETTINGS.levels.ultra, 'while an untouched one stays default');

  // Capturing an instant SDF and restoring it must not change the feel.
  const instant = captureSettings(
    { mode: 'marathon' },
    { das: 10, arr: 2, sdf: Infinity, dcd: 0 },
    fakeGame);
  eq(instant.handling.sdf, null, 'an instant SDF is captured as null');
  eq(settingsToConfig(instant).handling.sdf, Infinity, 'and restored as instant');
}

/* ------------------------------------------------------------ equality */

group('equality');

{
  const a = normalizeSettings({ handling: { das: 5 }, timing: { are: 2 } });
  const b = normalizeSettings({ handling: { das: 5 }, timing: { are: 2 } });
  ok(settingsEqual(a, b), 'equivalent settings compare equal');

  ok(!settingsEqual(a, normalizeSettings({ handling: { das: 6 } })),
    'a different DAS is not equal');
  ok(!settingsEqual(a, normalizeSettings({ mode: 'ultra' })), 'a different mode is not equal');
  ok(!settingsEqual(a, normalizeSettings({ timing: { are: 0 } })),
    'a different ARE is not equal');

  // Comparing against junk must not throw, and junk normalizes to the defaults
  // so it equals them.
  ok(settingsEqual('nonsense', null), 'junk compares equal to the defaults, without throwing');
  ok(!settingsEqual('nonsense', a), 'and unequal to real settings');
}

/* --------------------------------------------------------------- summary */

done('settings');
