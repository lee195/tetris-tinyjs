/**
 * Headless tests for scoring, T-spin detection and game modes.
 *
 *   node test/scoring.test.mjs
 *
 * The T-spin tests are the bulk of this file on purpose. The corner rule has
 * three ways to be wrong that all produce a plausible score — checking the wrong
 * corners per rotation, missing that walls count as solid, and forgetting the
 * SRS fifth-offset exception — and none of them throw. They just quietly award
 * the wrong number.
 */

import { COLS, TOTAL_ROWS, PIECE, TICK_HZ, TICK_MS } from '../src/frontend/js/constants.js';
import { makeBoard, setCell, recomputeTop, isPerfectClear, isEmpty } from '../src/frontend/js/board.js';
import { detectTSpin, TSPIN, LOCK_DELAY, gravityFrames } from '../src/frontend/js/rules.js';
import {
  makeGame, step, rotate, move, softDrop, hardDrop, gameHash, STATUS, ENDING,
  setStartLevel,
} from '../src/frontend/js/game.js';
import {
  scoreClear, dropPoints, basePoints, isDifficult, clearLabel,
} from '../src/frontend/js/scoring.js';
import {
  MODE, MODES, modeConfig, levelForLines, goalReached, formatTicks, ticksRemaining,
} from '../src/frontend/js/modes.js';
import { makeRng } from '../src/frontend/js/rng.js';
import { ok, eq, group, done } from './harness.mjs';

/* ---------------------------------------------------------------- helpers */

/** Fill the listed columns of a row with blocks. */
function fillRow(board, y, cols) {
  for (const x of cols) setCell(board, x, y, 1);
}

const range = (from, to) => {
  const out = [];
  for (let x = from; x <= to; x++) out.push(x);
  return out;
};

/**
 * A board with a T-spin double slot in the bottom-left.
 *
 *   row 37:  X X X X X X . . X X     <- (5,37) gives a third corner
 *   row 38:  X X X X X . . . X X     <- the T's three-wide row
 *   row 39:  X X X X X X . X X X     <- both front corners filled
 *
 * A T in rotation 2 at box origin (5, 37) fills rows 38 and 39 exactly.
 */
function tSpinDoubleBoard() {
  const b = makeBoard();
  fillRow(b, 37, [0, 1, 2, 3, 4, 5, 8, 9]);
  fillRow(b, 38, [0, 1, 2, 3, 4, 8, 9]);
  fillRow(b, 39, [0, 1, 2, 3, 4, 5, 7, 8, 9]);
  return b;
}

/**
 * The same slot shape but with only ONE front corner — the mini case.
 *
 *   row 37:  X X X X X X . X X X     <- both back corners filled
 *   row 38:  X X X X X . . . X X
 *   row 39:  X X X X X X . . X X     <- only (5,39) in front
 */
function tSpinMiniBoard() {
  const b = makeBoard();
  fillRow(b, 37, [0, 1, 2, 3, 4, 5, 7, 8, 9]);
  fillRow(b, 38, [0, 1, 2, 3, 4, 8, 9]);
  fillRow(b, 39, [0, 1, 2, 3, 4, 5, 8, 9]);
  return b;
}

/**
 * Put a T into a game at an exact position, ready to be locked.
 *
 * Deliberately does **not** arm the lock timer: a rotation resets it (that is
 * the lock-delay reset rule), so anything that rotates must arm it afterwards.
 * Use `lockNow` for that.
 */
function placeT(g, rot, x, y) {
  g.piece = PIECE.T;
  g.rot = rot;
  g.x = x;
  g.y = y;
  g.status = STATUS.FALLING;
  g.gravity = 0;
  g.lockTimer = 0;
}

/** Arm the lock timer and step once, so the piece locks this tick. */
function lockNow(g) {
  g.lockTimer = LOCK_DELAY;
  step(g);
}

/* ------------------------------------------------------------ t-spin detection */

group('T-spin detection');

{
  // Open space: no corners.
  eq(detectTSpin(makeBoard(), 2, 5, 20, 0), TSPIN.NONE, 'open space is not a T-spin');
}

{
  const b = tSpinDoubleBoard();
  eq(detectTSpin(b, 2, 5, 37, 0), TSPIN.FULL,
    'both front corners filled is a full T-spin');
}

{
  const b = tSpinMiniBoard();
  eq(detectTSpin(b, 2, 5, 37, 0), TSPIN.MINI,
    'one front corner filled is a mini T-spin');
  // The exception: SRS's fifth offset is the big displacement, so a piece that
  // could only have got there by being wedged counts as full regardless.
  eq(detectTSpin(b, 2, 5, 37, 4), TSPIN.FULL,
    'the fifth SRS offset promotes a mini to a full T-spin');
  eq(detectTSpin(b, 2, 5, 37, 3), TSPIN.MINI,
    'a smaller kick does not');
}

{
  // The rotation states face different ways, so the same board must classify
  // differently depending on which way the nub points. This is the check that
  // catches a T_FRONT table written for the wrong convention.
  const b = makeBoard();
  fillRow(b, 37, [0, 1, 2, 3, 4, 5, 8, 9]);   // (5,37) filled, (7,37) empty
  fillRow(b, 38, [0, 1, 2, 3, 4, 8, 9]);
  fillRow(b, 39, [0, 1, 2, 3, 4, 5, 7, 8, 9]);

  eq(detectTSpin(b, 2, 5, 37, 0), TSPIN.FULL, 'nub down sees both front corners');
  // The same board read the other way: the T's box is in the same place, but
  // nub-up makes the two bottom corners the *back* ones, so only one front
  // corner is filled and it is a mini. This is the assertion that catches a
  // T_FRONT table written for the wrong convention.
  eq(detectTSpin(b, 0, 5, 37, 0), TSPIN.MINI,
    'nub up sees only one front corner, so the same board reads as a mini');
}

{
  // Walls count as solid corners. A T pushed against the right wall has its
  // right-hand corners outside the board, which is why `solid()` must treat
  // out-of-bounds as blocking rather than empty.
  const b = makeBoard();
  fillRow(b, 32, [8]);   // one real corner, plus two wall corners
  eq(detectTSpin(b, 0, 8, 30, 0), TSPIN.MINI,
    'the right wall provides corners (nub up, so it reads as a mini)');
  eq(detectTSpin(makeBoard(), 0, 8, 30, 0), TSPIN.NONE,
    'with no filled corner there are only two, which is not enough');
}

/* ------------------------------------------------------- t-spin in the game */

group('T-spins through the real rotation path');

{
  const g = makeGame({ seed: 1 });
  step(g);                       // spawn, then overwrite the board
  g.board = tSpinDoubleBoard();
  placeT(g, 1, 5, 37);
  g.score = 0;
  g.combo = -1;
  g.backToBack = false;

  ok(rotate(g, 1), 'the T rotates into the slot');
  eq(g.rot, 2, 'landing in rotation 2');
  eq(g.x, 5, 'with the identity offset — no kick needed');
  eq(g.lastKick, 0, 'and the kick index is recorded');
  eq(g.lastAction, 'rotate', 'the last action is a rotation');
  eq(g.lockTimer, 0, 'and the rotation reset the lock delay, as it should');

  lockNow(g);
  eq(g.lastClear.tspin, TSPIN.FULL, 'detected as a full T-spin');
  eq(g.lastClear.label, 'T-SPIN DOUBLE', 'labelled for the HUD');
  eq(g.score, 1200, 'a T-spin double scores 1200 at level 1');
}

{
  // The action gate: the same position and the same piece, but the player moved
  // after rotating. Set directly rather than by contriving a board, because the
  // slot is wedged and the T genuinely cannot move once it is in.
  const g = makeGame({ seed: 1 });
  step(g);
  g.board = tSpinDoubleBoard();
  placeT(g, 1, 5, 37);
  g.score = 0;
  rotate(g, 1);
  g.lastAction = 'move';         // as a soft drop after the rotation would leave it

  lockNow(g);
  eq(g.lastClear.tspin, TSPIN.NONE, 'a move after the rotation is not a T-spin');
  eq(g.score, 300, 'and it scores as an ordinary double');
}

{
  // A soft drop really does invalidate it, end to end.
  const g = makeGame({ seed: 1 });
  step(g);
  const b = tSpinDoubleBoard();
  // Clear the row the T starts in so it has somewhere to fall from.
  fillRow(b, 36, []);
  setCell(b, 0, 36, 0);
  setCell(b, 1, 36, 0);
  setCell(b, 2, 36, 0);
  setCell(b, 3, 36, 0);
  setCell(b, 4, 36, 0);
  setCell(b, 5, 36, 0);
  setCell(b, 8, 36, 0);
  setCell(b, 9, 36, 0);
  g.board = b;
  placeT(g, 2, 5, 36);           // one row above the slot
  g.score = 0;
  g.lastAction = 'rotate';
  g.lockTimer = 0;

  ok(softDrop(g), 'the T soft-drops into the slot');
  eq(g.lastAction, 'move', 'a soft drop is a move');
  eq(g.y, 37, 'and it is now in the T-spin position');
  g.lockTimer = LOCK_DELAY;
  step(g);
  eq(g.lastClear.tspin, TSPIN.NONE, 'a soft drop invalidates the T-spin');
}

/* -------------------------------------------------------------- scoring tables */

group('scoring tables');

{
  eq(basePoints(TSPIN.NONE, 1), 100, 'a single is 100');
  eq(basePoints(TSPIN.NONE, 2), 300, 'a double is 300');
  eq(basePoints(TSPIN.NONE, 3), 500, 'a triple is 500');
  eq(basePoints(TSPIN.NONE, 4), 800, 'a tetris is 800');

  eq(basePoints(TSPIN.FULL, 0), 400, 'a T-spin with no lines is 400');
  eq(basePoints(TSPIN.FULL, 1), 800, 'a T-spin single is 800');
  eq(basePoints(TSPIN.FULL, 2), 1200, 'a T-spin double is 1200');
  eq(basePoints(TSPIN.FULL, 3), 1600, 'a T-spin triple is 1600');

  eq(basePoints(TSPIN.MINI, 0), 100, 'a mini T-spin is 100');
  eq(basePoints(TSPIN.MINI, 1), 200, 'a mini T-spin single is 200');
  eq(basePoints(TSPIN.MINI, 2), 400, 'a mini T-spin double is 400');

  eq(basePoints(TSPIN.NONE, 0), 0, 'no lines and no T-spin is worth nothing');
}

{
  // Level multiplies, and the multiplier is the level at the moment of the lock.
  eq(scoreClear({ lines: 4, tspin: TSPIN.NONE, level: 1, combo: -1 }).points, 800,
    'a tetris at level 1 is 800');
  eq(scoreClear({ lines: 4, tspin: TSPIN.NONE, level: 5, combo: -1 }).points, 4000,
    'and 4000 at level 5');
  eq(scoreClear({ lines: 2, tspin: TSPIN.FULL, level: 3, combo: -1 }).points, 3600,
    'a T-spin double at level 3 is 3600');
}

{
  ok(isDifficult(TSPIN.NONE, 4), 'a tetris is difficult');
  ok(isDifficult(TSPIN.FULL, 1), 'a full T-spin is difficult');
  ok(!isDifficult(TSPIN.NONE, 3), 'a triple is not');
  ok(!isDifficult(TSPIN.MINI, 2), 'a mini T-spin is not');

  eq(clearLabel(TSPIN.NONE, 4), 'TETRIS', 'labels read well');
  eq(clearLabel(TSPIN.FULL, 2), 'T-SPIN DOUBLE', 'including T-spins');
  eq(clearLabel(TSPIN.MINI, 1), 'T-SPIN MINI SINGLE', 'and minis');
  eq(clearLabel(TSPIN.FULL, 0), 'T-SPIN', 'and a T-spin with no lines');
}

/* ------------------------------------------------------- back-to-back and combo */

group('back-to-back');

{
  // The first difficult clear starts the chain and earns no bonus.
  const first = scoreClear({ lines: 4, tspin: TSPIN.NONE, level: 1, combo: -1, backToBack: false });
  eq(first.points, 800, 'the first tetris earns no back-to-back bonus');
  ok(first.backToBack, 'but it starts a chain');

  // Isolated from the combo bonus (combo -1 means the chain is not running, so
  // this clear becomes combo 0 and earns nothing extra) — the 1.5x is the only
  // thing in play. That state is reachable: a tetris, then a lock with no clear
  // resets the combo but leaves the back-to-back chain alone.
  const second = scoreClear({ lines: 4, tspin: TSPIN.NONE, level: 1, combo: -1, backToBack: true });
  eq(second.points, 1200, 'the next tetris earns the 1.5x bonus');
  ok(second.b2bApplied, 'and reports it');

  // And it stacks with a combo, which is the realistic case.
  const chained = scoreClear({ lines: 4, tspin: TSPIN.NONE, level: 1, combo: 0, backToBack: true });
  eq(chained.points, 800 * 1.5 + 50, 'back-to-back and the combo bonus stack');

  // A non-difficult clear breaks the chain.
  const broken = scoreClear({ lines: 2, tspin: TSPIN.NONE, level: 1, combo: -1, backToBack: true });
  eq(broken.points, 300, 'a double after a tetris earns nothing extra');
  ok(!broken.backToBack, 'and breaks the chain');

  // A T-spin that clears nothing leaves the chain alone.
  const noLines = scoreClear({ lines: 0, tspin: TSPIN.FULL, level: 1, combo: 0, backToBack: true });
  eq(noLines.points, 400, 'a zero-line T-spin scores its own value');
  ok(noLines.backToBack, 'and does not break the chain');
  eq(noLines.combo, -1, 'though it does break the combo');
}

group('combo');

{
  const first = scoreClear({ lines: 1, tspin: TSPIN.NONE, level: 1, combo: -1 });
  eq(first.combo, 0, 'the first clear of a chain is combo 0');
  eq(first.points, 100, 'and earns no combo bonus');

  const second = scoreClear({ lines: 1, tspin: TSPIN.NONE, level: 1, combo: 0 });
  eq(second.combo, 1, 'the second consecutive clear is combo 1');
  eq(second.points, 100 + 50, 'and adds 50 x combo x level');

  const third = scoreClear({ lines: 1, tspin: TSPIN.NONE, level: 2, combo: 1 });
  eq(third.combo, 2, 'the third is combo 2');
  eq(third.points, 200 + 200, 'and the bonus scales with level too');

  const broken = scoreClear({ lines: 0, tspin: TSPIN.NONE, level: 1, combo: 5 });
  eq(broken.combo, -1, 'a lock that clears nothing resets the combo');
  eq(broken.points, 0, 'and scores nothing');
}

group('perfect clears and drop points');

{
  const perfect = scoreClear({ lines: 4, tspin: TSPIN.NONE, level: 1, combo: -1, perfect: true });
  eq(perfect.points, 800 + 2000, 'a perfect clear adds its own bonus');

  const single = scoreClear({ lines: 1, tspin: TSPIN.NONE, level: 1, combo: -1, perfect: true });
  eq(single.points, 100 + 800, 'and it scales with the number of lines');

  eq(dropPoints(1, false), 1, 'a soft-dropped cell is 1 point');
  eq(dropPoints(7, false), 7, 'seven cells is 7');
  eq(dropPoints(1, true), 2, 'a hard-dropped cell is 2 points');
  eq(dropPoints(18, true), 36, 'and scales with distance');
}

{
  // isPerfectClear has to work *before* the rows come off the board, because
  // scoring happens at lock time while the clear waits out its delay.
  const b = makeBoard();
  ok(isPerfectClear(b), 'an empty board is trivially a perfect clear');

  for (let x = 0; x < COLS; x++) setCell(b, x, TOTAL_ROWS - 1, 1);
  ok(isPerfectClear(b), 'a board of only full rows clears to nothing');

  setCell(b, 3, TOTAL_ROWS - 2, 1);
  ok(!isPerfectClear(b), 'one leftover block is not a perfect clear');
  ok(!isEmpty(b), 'and isEmpty agrees it is not empty yet');
}

/* -------------------------------------------------------------------- modes */

group('modes');

{
  eq(modeConfig('nonsense').id, MODE.MARATHON, 'an unknown mode falls back to marathon');
  eq(modeConfig(undefined).id, MODE.MARATHON, 'and so does a missing one');

  eq(levelForLines(MODES.marathon, 0), 1, 'marathon starts at level 1');
  eq(levelForLines(MODES.marathon, 9), 1, 'and holds for nine lines');
  eq(levelForLines(MODES.marathon, 10), 2, 'then rises');
  eq(levelForLines(MODES.marathon, 25), 3, 'every ten lines');

  // Sprint holds a fixed level rather than curving. Referenced from the mode
  // rather than hardcoded, so changing the default is a one-line change.
  eq(levelForLines(MODES.sprint, 0), MODES.sprint.startLevel, 'sprint holds a fixed level');
  eq(levelForLines(MODES.sprint, 100), MODES.sprint.startLevel, 'however many lines are cleared');

  // The override is how a player's speed preference reaches the simulation.
  eq(levelForLines(MODES.sprint, 100, 9), 9, 'a start-level override is honoured');
  eq(levelForLines(MODES.marathon, 25, 3), 5, 'and marathon curves from it: 3 + floor(25/10)');

  eq(MODES.ultra.timeLimitTicks, 120 * TICK_HZ, 'ultra is two minutes of ticks');

  ok(goalReached(MODES.sprint, 40, 0), 'sprint ends at 40 lines');
  ok(!goalReached(MODES.sprint, 39, 0), 'and not before');
  ok(goalReached(MODES.ultra, 0, 120 * TICK_HZ), 'ultra ends when the ticks run out');
  ok(!goalReached(MODES.ultra, 0, 100), 'and not before');
  ok(!goalReached(MODES.marathon, 149, 0), 'marathon needs its full 150');
  ok(goalReached(MODES.marathon, 150, 0), 'and ends there');

  eq(formatTicks(0), '0:00.00', 'ticks format as a clock');
  eq(formatTicks(60), '0:01.00', 'one second');
  eq(formatTicks(60 * 61 + 30), '1:01.50', 'and minutes');
  eq(ticksRemaining(MODES.ultra, 0), 120 * TICK_HZ, 'remaining ticks count down');
  eq(ticksRemaining(MODES.ultra, 120 * TICK_HZ + 5), 0, 'and clamp at zero');
  eq(ticksRemaining(MODES.marathon, 100), 0, 'a mode with no limit reports none');
}

group('the speed a mode runs at');

{
  // Reported from play: "the fall speed in sprint seems fast". Sprint shipped at
  // level 8 — 8 frames per cell, 2.5 s for a piece to fall the height of the
  // well, against 19 s at Marathon's level 1. That is 7.6x faster, and it made
  // gravity the obstacle rather than the clock.
  const slow = makeGame({ seed: 1, mode: MODE.SPRINT });
  const fast = makeGame({ seed: 1, mode: MODE.SPRINT, startLevel: 8 });

  eq(slow.level, MODES.sprint.startLevel, 'sprint starts at the mode default');
  ok(slow.gravityFrames > fast.gravityFrames,
    'a lower start level means a slower fall (' + slow.gravityFrames + ' vs ' +
    fast.gravityFrames + ' frames/cell)');
  ok(slow.gravityFrames >= 20,
    'the default is no longer a race (' + slow.gravityFrames + ' frames/cell, ~' +
    (slow.gravityFrames * 19 * TICK_MS / 1000).toFixed(1) + 's for a full fall)');
  ok(slow.gravityFrames < gravityFrames(1),
    'but still faster than Marathon at level 1, so the mode has its own character');

  // A start level below 1 would be a piece that never falls.
  eq(makeGame({ seed: 1, mode: MODE.SPRINT, startLevel: 0 }).level, 1,
    'a start level of 0 is floored to 1');
  eq(makeGame({ seed: 1, mode: MODE.SPRINT, startLevel: -5 }).level, 1,
    'and so is a negative one');
}

{
  // A speed change mid-run must be felt at once, not at the next level-up.
  const s = makeGame({ seed: 1, mode: MODE.SPRINT });
  const before = s.gravityFrames;
  setStartLevel(s, 1);
  ok(s.gravityFrames > before, 'slowing down takes effect immediately');
  eq(s.level, 1, 'and the level follows');
  eq(s.startLevel, 1, 'and the preference is recorded on the state');

  // For a mode with a curve, the level is re-derived from the line count rather
  // than reset, so changing speed does not throw away the run's progress.
  const m = makeGame({ seed: 1, mode: MODE.MARATHON });
  m.lines = 25;
  setStartLevel(m, 3);
  eq(m.level, 5, 'a Marathon level is re-derived from the line count');
  eq(m.startLevel, 3, 'with the new start level recorded');
}

group('modes end the run');

{
  // A line goal ends the run with its own reason, not a top-out.
  const g = makeGame({ seed: 5, mode: MODE.SPRINT });
  step(g);
  g.lines = MODES.sprint.goalLines - 1;
  for (let x = 0; x < COLS; x++) setCell(g.board, x, TOTAL_ROWS - 1, 1);
  for (let x = 3; x <= 6; x++) setCell(g.board, x, TOTAL_ROWS - 1, 0);
  // Required after clearing cells by hand — see the note on setCell.
  recomputeTop(g.board);
  g.piece = PIECE.I;
  g.rot = 0;
  g.x = 3;
  // A horizontal I occupies the row *below* its origin, so the origin is one
  // row up from the row it fills.
  g.y = TOTAL_ROWS - 2;

  const piecesBefore = g.pieces;
  hardDrop(g);
  eq(g.pieces, piecesBefore, 'the final lock does not spawn a piece');
  eq(g.status, STATUS.CLEARING, 'the final row is clearing');

  step(g);
  eq(g.lines, MODES.sprint.goalLines, 'the goal line count is reached');
  eq(g.status, STATUS.OVER, 'and the run ends on the tick it clears');
  eq(g.result.reason, ENDING.GOAL, 'with the goal as the reason');
  eq(g.result.lines, 40, 'and the result records the run');
  ok(!g.dead, 'a completed run is not a top-out');

  // The specific complaint from play — "it ended one piece after the 40th line".
  // Pinned rather than changed: the run must end on the clearing tick, with the
  // piece counter untouched and nothing left active.
  eq(g.pieces, piecesBefore, 'no extra piece was spawned to reach the goal');
  eq(g.piece, -1, 'and no piece is left on the board');
}

{
  // A clear that *crosses* the goal ends at whatever count it reached, not at
  // the goal — and it must not take an extra piece to notice.
  function crossFrom(startLines) {
    const g = makeGame({ seed: 6, mode: MODE.SPRINT });
    step(g);
    g.lines = startLines;
    // An O fills two rows and two columns, so it can complete a double.
    for (let x = 0; x < COLS; x++) {
      setCell(g.board, x, TOTAL_ROWS - 2, 1);
      setCell(g.board, x, TOTAL_ROWS - 1, 1);
    }
    for (let x = 4; x <= 5; x++) {
      setCell(g.board, x, TOTAL_ROWS - 2, 0);
      setCell(g.board, x, TOTAL_ROWS - 1, 0);
    }
    recomputeTop(g.board);
    g.piece = PIECE.O;
    g.rot = 0;
    g.x = 4;
    g.y = TOTAL_ROWS - 2;
    const before = g.pieces;
    hardDrop(g);
    step(g);
    return { g, before };
  }

  const exact = crossFrom(38);
  eq(exact.g.lines, 40, 'a double from 38 lands exactly on the goal');
  eq(exact.g.status, STATUS.OVER, 'and ends');
  eq(exact.g.pieces, exact.before, 'without spawning anything');

  const over = crossFrom(39);
  eq(over.g.lines, 41, 'a double from 39 overshoots and ends at 41');
  eq(over.g.status, STATUS.OVER, 'and ends just the same');
  eq(over.g.pieces, over.before, 'also without spawning anything');
  eq(over.g.result.lines, 41, 'the result records the count it actually reached');
}

{
  // The time limit is a tick budget, so it is exactly reproducible.
  const g = makeGame({ seed: 6, mode: MODE.ULTRA });
  g.mode = Object.assign({}, MODES.ultra, { timeLimitTicks: 4 });
  step(g); step(g); step(g);
  ok(g.status !== STATUS.OVER, 'the run is alive before the limit');
  step(g);
  eq(g.status, STATUS.OVER, 'and ends when the ticks run out');
  eq(g.result.reason, ENDING.TIME, 'with time as the reason');
  eq(g.ticks, 4, 'having counted exactly the budget');
}

{
  // A top-out is a *blocked spawn*, not a full board — a full board just clears.
  // Blocking only the columns and rows a spawning piece occupies, and leaving a
  // gap elsewhere so no row is complete, isolates exactly that condition.
  const g = makeGame({ seed: 7 });
  for (let x = 3; x <= 6; x++) setCell(g.board, x, 20, 1);
  for (let x = 3; x <= 5; x++) setCell(g.board, x, 21, 1);
  recomputeTop(g.board);
  ok(!isPerfectClear(g.board), 'and the board is not a full one');

  // A new game starts in SPAWN with no delay, so this step attempts the spawn.
  step(g);
  eq(g.status, STATUS.OVER, 'a blocked spawn ends the run');
  eq(g.result.reason, ENDING.TOPOUT, 'as a top-out');
  ok(g.dead, 'and the dead flag is set');
  eq(g.pieces, 0, 'no piece was ever counted');
  eq(g.result.lines, 0, 'and the result records an empty run');
}

/* ----------------------------------------------------- determinism with scoring */

group('scoring is deterministic');

{
  function play(seed, mode, ticks) {
    const g = makeGame({ seed, mode });
    const rnd = makeRng(0x51ce);
    for (let t = 0; t < ticks; t++) {
      step(g);
      if (g.status === STATUS.FALLING) {
        const r = rnd();
        if (r < 0.2) move(g, -1);
        else if (r < 0.4) move(g, 1);
        else if (r < 0.5) rotate(g, 1);
        else if (r < 0.56) rotate(g, -1);
        else if (r < 0.7) softDrop(g);
        else if (r < 0.76) hardDrop(g);
      }
    }
    return { hash: gameHash(g), score: g.score, lines: g.lines, g };
  }

  const a = play(99, MODE.MARATHON, 5000);
  const b = play(99, MODE.MARATHON, 5000);
  eq(a.hash, b.hash, 'the same seed and actions give the same state');
  eq(a.score, b.score, 'and the same score');
  eq(a.lines, b.lines, 'and the same line count');
  ok(a.score > 0, 'the script actually scored something');
  ok(a.g.pieces > 3, 'and played several pieces');

  const c = play(100, MODE.MARATHON, 5000);
  ok(c.hash !== a.hash, 'a different seed diverges');

  // The mode is part of the simulated state, not just presentation.
  const d = play(99, MODE.SPRINT, 5000);
  ok(d.hash !== a.hash, 'a different mode produces a different game');
}

/* --------------------------------------------------------------- summary */

done('scoring, T-spins and modes');
