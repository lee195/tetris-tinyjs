/**
 * The driver: input -> tick(s) -> render, once per animation frame.
 *
 * This is the only module that knows about all the others, and it is
 * deliberately thin — it wires, it does not decide. The frame order is the
 * latency-critical detail from the plan: input is applied to the simulation
 * *before* the tick runs, so a key pressed between two frames is visible in the
 * frame it arrives rather than the one after. Worst case is therefore one frame
 * (~16.7 ms), not two.
 *
 * Two subtleties worth stating, because both are easy to "fix" into bugs:
 *
 *  - **Input is polled only on frames that actually run a tick.** `pollInput`
 *    consumes the edge latches, so polling on a frame where the accumulator
 *    yields zero ticks would silently swallow a press. Leaving the latches in
 *    place means the next frame that ticks picks them up — correct, since there
 *    was no simulation step for the press to apply to.
 *  - **The replay log is recorded per tick, not per frame.** The keyboard is
 *    polled once per frame but several ticks may run in it, and `tick()` has
 *    consumed the edges by the second one. So `recordTick` is called inside the
 *    tick loop, before each step.
 */

import { TICK_MS } from './constants.js';
import { makeGame, STATUS } from './game.js';
import { MODE, MODE_LIST } from './modes.js';
import { makeHandling, makeInputFrame, resetHandling, DEFAULT_HANDLING } from './handling.js';
import { makeInput, attachInput, pollInput } from './input.js';
import { stepWithInput } from './apply.js';
import { makeLoop, advance, resetLoop } from './loop.js';
import { makeRenderer, draw } from './render.js';
import { makePerf, recordFrame, stats, resetPerf, drawPerf } from './perf.js';
import {
  makeRecorder, recordTick, finishRecording, buildReplay, verifyReplay,
  startPlayback, playbackStep,
} from './replay.js';
import { runSelfTest } from './selftest.js';

/** How long a "TETRIS" / "T-SPIN DOUBLE" callout stays on screen, in ticks. */
const BANNER_TICKS = 66;

const canvas = document.getElementById('game');
const renderer = makeRenderer(canvas);
const perf = makePerf();
const perfOut = {};
const loop = makeLoop();
const input = makeInput();
const frame = makeInputFrame();
const handling = makeHandling(DEFAULT_HANDLING);

/** Reused, never rebuilt — the draw call must not allocate. */
const flags = { paused: false, over: false, banner: '' };

/** The live run. */
let game;
/** A playback being watched, or null. Takes over the display while set. */
let watch = null;
/** A playback raced alongside the live run, or null. */
let ghost = null;

let recorder = makeRecorder();
let runRecorded = false;
let lastReplay = null;
/** The best-scoring replay of this session — the ghost's source. */
let bestReplay = null;

let showPerf = false;
let mode = MODE.MARATHON;
/** Identity of the last clear we showed a banner for, and when to stop. */
let seenClear = null;
let banner = '';
let bannerUntil = 0;

function newGame(seed, nextMode) {
  if (nextMode) mode = nextMode;
  // The seed is chosen once per game and recorded, because a replay is a seed
  // plus an input log.
  game = makeGame({
    seed: seed === undefined ? (Date.now() >>> 0) : seed,
    mode,
  });
  resetHandling(handling);
  resetLoop(loop);
  resetPerf(perf);
  recorder = makeRecorder();
  runRecorded = false;
  watch = null;
  ghost = null;
  seenClear = null;
  banner = '';
  bannerUntil = 0;
}

/** Focus loss pauses. The input adapter has already cleared the held keys. */
function isPaused() {
  return input.paused === true;
}

/* ---------------------------------------------------------------- replays */

/**
 * The run is over: close the log, build the replay, and check it reproduces.
 *
 * The verification re-runs the whole log, which is a few milliseconds — paid
 * once, on the frame the game ended, where a hitch cannot be felt. It is worth
 * paying every time: a replay that does not reproduce means something in the
 * simulation has become non-deterministic, and the only place that can be
 * noticed cheaply is here.
 */
function finishRun() {
  runRecorded = true;
  finishRecording(recorder);
  lastReplay = buildReplay(game, handling.cfg, recorder.pairs);

  const v = verifyReplay(lastReplay);
  const summary = 'replay: ' + lastReplay.ticks + ' ticks in ' +
    (lastReplay.log.length / 2) + ' pairs, score ' + v.score;
  if (v.ok) {
    report(summary + ' — verified');
  } else {
    report(summary + ' — DID NOT VERIFY (' + v.actual + ' vs ' + v.expected + ')');
  }

  const score = lastReplay.result ? lastReplay.result.score : 0;
  const best = bestReplay && bestReplay.result ? bestReplay.result.score : -1;
  if (score > best) bestReplay = lastReplay;
}

/** Watch the last run back. */
function watchReplay(replay) {
  if (!replay) {
    report('replay: nothing recorded yet');
    return;
  }
  watch = startPlayback(replay);
  watch.done = false;
  ghost = null;
  seenClear = null;
  banner = '';
}

/** Race the session's best run alongside the live one. */
function toggleGhost() {
  if (ghost) { ghost = null; return; }
  if (watch) return;                    // not while watching a replay
  if (!bestReplay) {
    report('ghost: no completed run to race yet');
    return;
  }
  ghost = startPlayback(bestReplay);
  ghost.done = false;
}

/* ------------------------------------------------------------------- frame */

let last = 0;

function onFrame(now) {
  const dt = last === 0 ? 0 : now - last;
  last = now;

  const droppedBefore = loop.dropped;
  let ticks = 0;

  if (isPaused()) {
    // Drop the elapsed time rather than banking it: on resume the player should
    // pick up where they left off, not watch a burst of catch-up.
    loop.acc = 0;
  } else {
    ticks = advance(loop, dt);

    if (ticks > 0 && watch) {
      // Watching: the log drives the simulation instead of the keyboard.
      for (let i = 0; i < ticks && !watch.done; i++) {
        if (!playbackStep(watch)) watch.done = true;
      }
    } else if (ticks > 0) {
      pollInput(input, frame);
      for (let i = 0; i < ticks; i++) {
        // Before the tick consumes the edges — see the note at the top.
        if (!runRecorded) recordTick(recorder, frame);
        stepWithInput(game, handling, frame);
        if (ghost && !ghost.done && !playbackStep(ghost)) ghost.done = true;
        if (game.status === STATUS.OVER) break;
      }
    }
  }

  if (!watch && !runRecorded && game.status === STATUS.OVER) finishRun();

  const shown = watch ? watch.game : game;

  // The clear callout. `lastClear` is a fresh object per lock, so identity is
  // the signal; comparing values would need a tick stamp in the sim, which is
  // presentation state that does not belong there.
  if (shown.lastClear && shown.lastClear !== seenClear) {
    seenClear = shown.lastClear;
    banner = shown.lastClear.label;
    if (shown.lastClear.b2bApplied) banner = 'B2B ' + banner;
    if (shown.lastClear.combo > 0) banner += '  +' + shown.lastClear.combo + ' COMBO';
    bannerUntil = shown.ticks + BANNER_TICKS;
  }

  flags.over = shown.status === STATUS.OVER;
  flags.banner = shown.ticks < bannerUntil ? banner : '';
  flags.paused = isPaused();
  flags.watching = !!watch;
  flags.ghost = !!ghost;

  // The ghost's board is drawn dimly under the live one, so a race reads as one
  // stack behind another rather than two pictures to compare by eye.
  draw(renderer, shown, flags, ghost ? ghost.game : null);
  recordFrame(perf, dt, renderer.drawMs, ticks, loop.dropped !== droppedBefore);

  if (showPerf) {
    stats(perf, perfOut);
    drawPerf(renderer.ctx, perfOut, perf, renderer.drawMs, 12, 12);
  }

  requestAnimationFrame(onFrame);
}

/* ------------------------------------------------------------------- wiring */

/**
 * Report to the launcher's stdout.
 *
 * Without this an uncaught page error is *invisible*: `console.log` is not
 * forwarded from the page, so the game would simply stop animating with no
 * diagnostic anywhere. Worth having permanently, not just for debugging.
 */
function report(msg) {
  if (typeof tiny !== 'undefined' && tiny.api) {
    tiny.api.call('log', { msg: 'error: ' + msg }).catch(() => {});
  }
}

window.addEventListener('error', (e) => {
  report((e.message || 'unknown') + ' at ' + (e.filename || '?') + ':' + (e.lineno || 0));
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  report('unhandled rejection: ' + (r && r.message ? r.message : String(r)));
});

attachInput(input, window, null);

/**
 * Lifecycle keys are handled here rather than in the game's key map: restarting,
 * choosing a mode and watching a replay are driver concerns, not input-handling
 * ones, and a keydown event is already an edge so it needs no latching.
 *
 * Number keys pick a mode. A proper menu belongs in Phase 5; this is the minimum
 * that makes the modes reachable.
 */
const MODE_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2 };

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.code === 'Escape') { watch = null; return; }
  if (e.code === 'KeyV') {
    if (watch) watch = null;
    else watchReplay(lastReplay);
    return;
  }
  if (e.code === 'KeyG') { toggleGhost(); return; }

  const pick = MODE_KEYS[e.code];
  if (pick !== undefined && MODE_LIST[pick]) {
    newGame(undefined, MODE_LIST[pick]);
    return;
  }

  if (e.code === 'Enter' && game.status === STATUS.OVER) newGame();
  else if (e.code === 'KeyR') newGame();
  else if (e.code === 'KeyP') showPerf = !showPerf;
});

newGame();

/**
 * Bench mode, for verifying a change without a human at the keyboard. The
 * backend reports whether TETRIS_BENCH is set in the launcher's environment.
 */
async function maybeBench() {
  if (typeof tiny === 'undefined' || !tiny.api) return false;
  let want = false;
  try {
    want = await tiny.api.call('bench');
  } catch (err) {
    return false;
  }
  if (!want) return false;

  // Report *before* anything that can block. The activation below awaits a
  // timer, and a suspended timer in an occluded window never resolves — so
  // without this line a stalled bench run produces no output at all, and
  // "the page never loaded" and "the window was hidden" look identical.
  await tiny.api.call('log', { msg: 'bench: page up, bench flag set' });

  // The pacing half of the self-test needs a *visible* window: WebKit stops rAF
  // when the window is occluded, so a launch that leaves the window behind
  // another would stall. Bring it to the front first, then give it a moment to
  // actually be on screen.
  try {
    await tiny.win.show({ activate: true });
    await new Promise((r) => setTimeout(r, 400));
  } catch (err) {
    await tiny.api.call('log', { msg: 'bench: could not activate the window: ' + err });
  }

  // Which display this is running on decides how to read the pacing numbers —
  // and whether the 60 fps cap is in play at all — so record it rather than
  // guessing from the frame rate afterwards.
  try {
    const screens = await tiny.app.screens();
    await tiny.api.call('log', { msg: 'bench: displays ' + JSON.stringify(screens) });
  } catch (err) {
    await tiny.api.call('log', { msg: 'bench: could not read displays: ' + err });
  }

  // A failure here must still quit: otherwise the app hangs and reports
  // nothing, which is exactly how a missing argument turned into a silent
  // 40-second stall the first time this ran.
  try {
    await runSelfTest({
      canvas,
      renderer,
      perf,
      log: (m) => tiny.api.call('log', { msg: m }),
    });
  } catch (err) {
    await tiny.api.call('log', { msg: 'bench: self-test threw: ' + (err && err.message ? err.message : err) });
  }
  await tiny.api.call('quit');
  return true;
}

maybeBench().then((benched) => {
  if (!benched) requestAnimationFrame(onFrame);
});
