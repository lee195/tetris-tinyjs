/**
 * Headless tests for the pre-run countdown.
 *
 *   node test/countdown.test.mjs
 *
 * The countdown is driver-side and pure, which is the whole reason it is a
 * module rather than a few lines in `main.js`: the interesting behaviour — the
 * straddling frame, the GO window, the skip — is exactly the kind of arithmetic
 * that a live game hides and a test can pin.
 */

import {
  makeCountdown, startCountdown, skipCountdown, isCountingDown,
  advanceCountdown, fadeCountdown, countdownLabel,
  COUNTDOWN_SECONDS, GO_TICKS,
} from '../src/frontend/js/countdown.js';
import { TICK_HZ } from '../src/frontend/js/constants.js';
import { ok, eq, group, done } from './harness.mjs';

/* -------------------------------------------------------------------- start */

group('starting');

{
  const c = makeCountdown();
  eq(c.ticks, 0, 'a fresh countdown is idle');
  eq(isCountingDown(c), false, 'and reports as idle');
  eq(countdownLabel(c), '', 'with nothing to show');

  startCountdown(c, COUNTDOWN_SECONDS);
  eq(c.ticks, COUNTDOWN_SECONDS * TICK_HZ, 'starting sets one tick per second');
  eq(isCountingDown(c), true, 'and it is now counting');
  eq(countdownLabel(c), '3', 'which reads as 3');

  // A second start resets, rather than adding to, the countdown.
  startCountdown(c, 1);
  eq(c.ticks, TICK_HZ, 'restarting replaces the remaining time');
}

{
  // Zero disables it, which is the shape a future setting wants without a
  // second code path.
  const c = makeCountdown();
  startCountdown(c, 0);
  eq(isCountingDown(c), false, 'zero seconds is no countdown');
  eq(countdownLabel(c), '', 'and shows nothing');
  startCountdown(c, -1);
  eq(isCountingDown(c), false, 'a negative length is treated as off');
  startCountdown(c, NaN);
  eq(isCountingDown(c), false, 'and so is a NaN from a bad setting');
}

/* ------------------------------------------------------------------- labels */

group('the label counts 3, 2, 1');

{
  const c = makeCountdown();
  startCountdown(c, 3);

  eq(countdownLabel(c), '3', 'at the top it reads 3');
  advanceCountdown(c, 1);
  eq(countdownLabel(c), '3', 'still 3 one tick in — it is ceil, not floor');
  advanceCountdown(c, TICK_HZ - 1);
  eq(countdownLabel(c), '2', 'and 2 after a full second');

  advanceCountdown(c, TICK_HZ);
  eq(countdownLabel(c), '1', 'then 1');
  eq(isCountingDown(c), true, 'still counting at 1');

  // The last second, then the run begins.
  const left = advanceCountdown(c, TICK_HZ);
  eq(left, 0, 'consuming the last second leaves no leftover');
  eq(isCountingDown(c), false, 'and the countdown is over');
  eq(countdownLabel(c), 'GO', 'which flashes GO rather than a dead 0');
}

/* --------------------------------------------------------------- straddling */

group('a frame that straddles the end');

{
  // The load-bearing case: a frame can produce more ticks than the countdown has
  // left. The remainder must come back, or the simulation loses time.
  const c = makeCountdown();
  startCountdown(c, 1);
  const left = advanceCountdown(c, TICK_HZ + 7);
  eq(left, 7, 'the ticks past the end are handed back');
  eq(isCountingDown(c), false, 'and the countdown is finished');

  // And once it is over, every tick passes straight through.
  eq(advanceCountdown(c, 5), 5, 'a finished countdown passes all ticks through');
}

/* ------------------------------------------------------------------- GO */

group('the GO window');

{
  const c = makeCountdown();
  startCountdown(c, 1);
  advanceCountdown(c, TICK_HZ);
  eq(c.go, GO_TICKS, 'finishing arms the GO window');
  eq(countdownLabel(c), 'GO', 'which shows GO');

  fadeCountdown(c, GO_TICKS);
  eq(c.go, 0, 'and it fades to nothing');
  eq(countdownLabel(c), '', 'leaving a clean screen');

  // Fading past zero must not go negative — a negative window would show GO
  // forever under a later `> 0` check that used the wrong bound.
  fadeCountdown(c, 5);
  eq(c.go, 0, 'and never goes negative');
}

/* ------------------------------------------------------------------- skip */

group('skipping');

{
  const c = makeCountdown();
  startCountdown(c, 3);
  skipCountdown(c);
  eq(isCountingDown(c), false, 'a skip ends the wait at once');
  eq(countdownLabel(c), 'GO', 'and still flashes GO');

  // Skipping an idle countdown must not arm a GO out of nowhere.
  const idle = makeCountdown();
  skipCountdown(idle);
  eq(idle.go, 0, 'skipping when idle does nothing');
  eq(countdownLabel(idle), '', 'and shows nothing');
}

done('countdown');
