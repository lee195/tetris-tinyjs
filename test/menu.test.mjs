/**
 * Headless tests for the title screen's model.
 *
 *   node test/menu.test.mjs
 *
 * The menu itself is DOM, so the bench cannot pixel-check it the way it checks
 * the canvas. That is the whole reason the model is a separate module, and it is
 * why these tests carry the weight the pixel readback carries elsewhere.
 *
 * The cases worth having are the ones that fail *quietly*: a highlight that
 * stops dead at the bottom of the list, a score table showing one mode's rows
 * under another mode's heading, or a new mode being added to `modes.js` and never
 * appearing on the title screen.
 */

import {
  buildItems, goalText, bestFor, scoreRows, moveSelection, keyToAction,
  confirmKey, itemAt, modeAt, replayRows, formatWhen, replayFilters, filterReplays,
  ALL_MODES, ITEM, SCORE_ROWS,
} from '../src/frontend/js/menuModel.js';
import { MODES, MODE_LIST, formatTicks, formatDuration } from '../src/frontend/js/modes.js';
import { ok, eq, group, done } from './harness.mjs';

/* -------------------------------------------------------------------- rows */

group('the rows');

{
  const items = buildItems();
  eq(items.length, MODE_LIST.length + 2, 'one row per mode, plus Replays and Settings');
  eq(items[items.length - 1].kind, ITEM.SETTINGS, 'Settings is last');
  eq(items[items.length - 2].kind, ITEM.REPLAYS, 'Replays sits just above it');

  // The guard that matters: a mode added to modes.js must appear here without
  // anyone remembering to edit this file. Iterating MODE_LIST is what makes that
  // true, and this pins it.
  let everyModePresent = true;
  for (let i = 0; i < MODE_LIST.length; i++) {
    if (items[i].kind !== ITEM.MODE || items[i].id !== MODE_LIST[i]) everyModePresent = false;
  }
  ok(everyModePresent, 'every mode appears, in MODE_LIST order');

  let labelled = true;
  for (const it of items) {
    if (!it.label || typeof it.blurb !== 'string') labelled = false;
  }
  ok(labelled, 'every row carries a label and a blurb');

  eq(items[0].id, MODE_LIST[0], 'the first row is the first mode');
  ok(items[0].goal.length > 0, 'a mode row states its goal  [' + items[0].goal + ']');
}

/* ------------------------------------------------------------------- goals */

group('the goal text');

{
  eq(goalText(MODES.marathon), '150 lines', 'a line goal reads as lines');
  eq(goalText(MODES.sprint), '40 lines', 'and so does sprint');
  eq(goalText(MODES.ultra), formatDuration(MODES.ultra.timeLimitTicks),
    'a timed mode reads as a clock');
  eq(goalText(MODES.ultra), '2:00', 'which is two minutes for ultra');
  // A goal is a round number. The hundredths a *measured* time carries would
  // claim a precision the mode does not have, so the two formatters stay apart.
  ok(goalText(MODES.ultra) !== formatTicks(MODES.ultra.timeLimitTicks),
    'and a goal is written without hundredths');

  // Both at once: no mode has this today, and the reason to handle it is that the
  // alternative silently drops half the answer the day one does.
  eq(goalText({ goalLines: 40, timeLimitTicks: 7200 }), '40 lines in 2:00',
    'a mode with both states both');

  eq(goalText({ goalLines: 0, timeLimitTicks: 0 }), '', 'an open-ended mode has no goal text');
  eq(goalText(null), '', 'and a missing mode is not a crash');
  eq(goalText(undefined), '', 'nor is undefined');
}

/* ------------------------------------------------------------------- bests */

group('the best score');

{
  const table = [
    { mode: 'marathon', score: 1000, lines: 10, ticks: 600, date: 1 },
    { mode: 'sprint', score: 9000, lines: 40, ticks: 3000, date: 2 },
    { mode: 'marathon', score: 4000, lines: 30, ticks: 900, date: 3 },
  ];
  eq(bestFor(table, 'marathon'), 4000, 'the best for a mode is its highest score');
  // A Marathon score and a Sprint time are not comparable, so mixing them would
  // show a Sprint "best" while playing Marathon.
  eq(bestFor(table, 'sprint'), 9000, 'and is computed per mode');
  eq(bestFor(table, 'ultra'), 0, 'a mode with no scores has no best');
  eq(bestFor([], 'marathon'), 0, 'an empty table has no best');
  eq(bestFor(null, 'marathon'), 0, 'and neither does a missing one');
  eq(bestFor(undefined, 'marathon'), 0, 'nor undefined');
}

/* -------------------------------------------------------------- score rows */

group('the score rows');

{
  const table = [
    { mode: 'marathon', score: 1000, lines: 10, ticks: 600, reason: 'topout', date: 1 },
    { mode: 'sprint', score: 9000, lines: 40, ticks: 3000, reason: 'goal', date: 2 },
    { mode: 'marathon', score: 4000, lines: 30, ticks: 900, reason: 'topout', date: 3 },
    { mode: 'marathon', score: 4000, lines: 31, ticks: 950, reason: 'goal', date: 4 },
  ];
  const rows = scoreRows(table, 'marathon');
  eq(rows.length, 3, 'only the asked-for mode comes back');
  eq(rows[0].score, 4000, 'sorted best first');
  eq(rows[0].rank, 1, 'ranked from one');
  eq(rows[2].score, 1000, 'and the worst is last');
  eq(rows[0].time, formatTicks(950), 'the time is formatted from ticks');

  // Equal scores break on date, newest first — the same order the backend keeps,
  // and the reason a tie does not shuffle between renders.
  eq(rows[0].date, undefined, 'the row carries only what it renders');
  eq(rows[0].lines, 31, 'and the line count');
  eq(rows[0].reason, 'goal', 'and why the run ended');

  const limited = scoreRows(table, 'marathon', 2);
  eq(limited.length, 2, 'a limit truncates');
  eq(limited[1].rank, 2, 'and the ranks stay contiguous');

  eq(scoreRows(table, 'ultra').length, 0, 'a mode with no scores has no rows');
  eq(scoreRows(null, 'marathon').length, 0, 'a missing table is not a crash');
  eq(scoreRows([{ mode: 'marathon', score: 5, ticks: 0 }], 'marathon', 99).length, 1,
    'a limit past the end is harmless');

  // The default limit is the module's, so the screen cannot drift from it.
  ok(SCORE_ROWS > 0 && SCORE_ROWS <= 10, 'the default row count is sane  [' + SCORE_ROWS + ']');
}

/* --------------------------------------------------------------- selection */

group('the selection');

{
  eq(moveSelection(0, -1, 4), 3, 'moving up from the top wraps to the bottom');
  eq(moveSelection(3, 1, 4), 0, 'and down from the bottom wraps to the top');
  eq(moveSelection(1, 1, 4), 2, 'a move in the middle is just a move');
  eq(moveSelection(0, 2, 4), 2, 'and a jump lands where it should');

  // The double modulo is what makes this work rather than returning -1.
  eq(moveSelection(0, -2, 3), 1, 'a large negative delta wraps correctly');
  eq(moveSelection(1, -5, 3), 2, 'and so does a very large one');

  eq(moveSelection(0, 1, 1), 0, 'a one-row menu stays put');
  eq(moveSelection(0, 1, 0), 0, 'and an empty one does not divide by zero');
  eq(moveSelection(5, 1, 3), 0, 'an out-of-range index is brought back into range');
}

/* ------------------------------------------------------------------- keys */

group('the keys');

{
  eq(keyToAction('ArrowUp'), 'up', 'up is up');
  eq(keyToAction('ArrowDown'), 'down', 'down is down');
  eq(keyToAction('Enter'), 'start', 'enter starts');
  eq(keyToAction('NumpadEnter'), 'start', 'and so does the keypad enter');
  eq(keyToAction('Space'), 'start', 'and space, which is the key people actually press');
  eq(keyToAction('Escape'), 'close', 'escape closes');

  // Physical keys, matching input.js — so W/S work on a Dvorak layout too.
  eq(keyToAction('KeyW'), 'up', 'W is an alias for up');
  eq(keyToAction('KeyS'), 'down', 'and S for down');
  eq(keyToAction('ArrowLeft'), 'left', 'left is left, for the replay filter');
  eq(keyToAction('ArrowRight'), 'right', 'and right is right');
  eq(keyToAction('KeyA'), 'left', 'with A and D as aliases, matching input.js');
  eq(keyToAction('KeyD'), 'right', 'both of them');

  // Everything the menu does not own must return null, or the driver would
  // swallow a key it should have handled — `O` and the mode digits among them.
  eq(keyToAction('KeyO'), null, 'O belongs to the driver, not the menu');
  eq(keyToAction('Digit1'), null, 'and so do the mode digits');
  eq(keyToAction('KeyR'), null, 'and restart');
  eq(keyToAction('KeyP'), null, 'and the perf overlay');
  eq(keyToAction('KeyQ'), null, 'and anything unmapped');
  eq(keyToAction(''), null, 'and an empty code');
}

/* ----------------------------------------------------------- confirm keys */

group('the confirm keys');

{
  // The quit prompt's answers. Enter/Y quit and Escape/N cancel, so the prompt
  // works without moving a hand to the arrows.
  eq(confirmKey('Enter'), 'yes', 'enter confirms');
  eq(confirmKey('NumpadEnter'), 'yes', 'and so does the keypad enter');
  eq(confirmKey('KeyY'), 'yes', 'and Y for yes');
  eq(confirmKey('Escape'), 'no', 'escape cancels');
  eq(confirmKey('KeyN'), 'no', 'and N for no');

  // Everything else must be null, or the driver would swallow a key it should
  // have handled — the mode digits among them.
  eq(confirmKey('KeyO'), null, 'O is not an answer');
  eq(confirmKey('Digit1'), null, 'and neither are the mode digits');
  eq(confirmKey('ArrowUp'), null, 'nor the arrows');
  eq(confirmKey(''), null, 'and an empty code is not an answer');
}

/* ------------------------------------------------------------- row lookups */

group('the replay rows');

{
  // The backend index is sorted best-first; the picker must not inherit that.
  const list = [
    { id: 'a', mode: MODE_LIST[0], score: 900, lines: 10, ticks: 600, date: 1000 },
    { id: 'b', mode: MODE_LIST[0], score: 500, lines: 4, ticks: 300, date: 3000 },
    { id: 'c', mode: MODE_LIST[0], score: 100, lines: 1, ticks: 60, date: 2000 },
  ];
  const rows = replayRows(list);
  eq(rows.map((r) => r.id).join(','), 'b,c,a', 'newest first, whatever the score order');
  eq(list[0].id, 'a', 'and the input list is left alone');
  eq(rows[0].mode, MODES[MODE_LIST[0]].label, 'a row carries the mode label');
  eq(rows[0].time, formatTicks(300), 'and its run time');

  const tied = replayRows([
    { id: 'x1', mode: MODE_LIST[0], date: 5 },
    { id: 'x2', mode: MODE_LIST[0], date: 5 },
  ]);
  eq(tied.map((r) => r.id).join(','), 'x2,x1', 'a tie on the date breaks on the id, stably');

  eq(replayRows(null).length, 0, 'a missing list is not a crash');
  eq(replayRows([]).length, 0, 'an empty list gives no rows');
  eq(replayRows([null, { score: 1 }]).length, 0, 'entries without an id are skipped');
  eq(replayRows([{ id: 'z', mode: 'nonesuch', date: 1 }])[0].mode, 'nonesuch',
    'an unknown mode falls back to its id');

  eq(formatWhen(new Date(2026, 0, 2, 3, 4).getTime()), '2026-01-02 03:04',
    'a timestamp reads as YYYY-MM-DD HH:MM, zero-padded');
  eq(formatWhen(undefined), '', 'and a missing one reads as nothing');
}

group('the replay filters');

{
  const fs = replayFilters();
  eq(fs.length, MODE_LIST.length + 1, 'All, then one filter per mode');
  eq(fs[0].id, ALL_MODES, 'All comes first, so it is the default');
  let inOrder = true;
  for (let i = 0; i < MODE_LIST.length; i++) if (fs[i + 1].id !== MODE_LIST[i]) inOrder = false;
  ok(inOrder, 'the mode filters follow MODE_LIST');

  const other = MODE_LIST[1] || MODE_LIST[0];
  const rows = replayRows([
    { id: 'a', mode: MODE_LIST[0], date: 1 },
    { id: 'b', mode: other, date: 3 },
    { id: 'c', mode: MODE_LIST[0], date: 2 },
  ]);
  eq(filterReplays(rows, ALL_MODES).map((r) => r.id).join(','), 'b,c,a', 'All keeps everything');
  eq(filterReplays(rows, undefined).length, 3, 'and so does no filter at all');
  eq(filterReplays(rows, MODE_LIST[0]).map((r) => r.id).join(','), 'c,a',
    'a mode filter keeps only that mode, still newest first');
  eq(filterReplays(rows, 'nonesuch').length, 0, 'an unknown filter keeps nothing');
  eq(filterReplays(null, ALL_MODES).length, 0, 'a missing list is not a crash');
}

group('looking a row up');

{
  const items = buildItems();

  eq(itemAt(items, 0).id, MODE_LIST[0], 'index zero is the first row');
  eq(itemAt(items, items.length - 1).kind, ITEM.SETTINGS, 'and the last is Settings');
  eq(itemAt(items, -1), null, 'a negative index finds nothing');
  eq(itemAt(items, items.length), null, 'and one past the end finds nothing');
  eq(itemAt(null, 0), null, 'a missing list is not a crash');

  eq(modeAt(items, 0), MODE_LIST[0], 'a mode row resolves to its mode id');
  // The case that keeps the score panel honest: highlighting Settings must not
  // leave the previous mode's scores on screen, which would read as a bug.
  eq(modeAt(items, items.length - 1), null, 'while Settings resolves to no mode');
  eq(modeAt(items, 99), null, 'and an out-of-range index resolves to nothing');
}

done('menu');
