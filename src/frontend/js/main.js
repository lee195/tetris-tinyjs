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
import { makeGame, STATUS, setTiming, setStartLevel } from './game.js';
import { MODE, MODE_LIST } from './modes.js';
import { makeHandling, makeInputFrame, resetHandling, setHandling } from './handling.js';
import { makeInput, attachInput, pollInput, resetInput } from './input.js';
import { stepWithInput } from './apply.js';
import { makeLoop, advance, resetLoop } from './loop.js';
import { makeRenderer, draw } from './render.js';
import { makePerf, recordFrame, stats, resetPerf, drawPerf } from './perf.js';
import {
  makeRecorder, recordTick, finishRecording, buildReplay, verifyReplay,
  startPlayback, playbackStep, scoreEntry,
} from './replay.js';
import { normalizeSettings, settingsToConfig, captureSettings } from './settings.js';
import { makePanel } from './panel.js';
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
const handling = makeHandling(normalizeSettings(null).handling);

/** Reused, never rebuilt — the draw call must not allocate. */
const flags = { paused: false, over: false, banner: '', watching: false, ghost: false, priorBest: 0 };

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

let settings = normalizeSettings(null);
/** The persisted score table, kept in memory so the best can be shown live. */
let scoreTable = [];
/**
 * The stored best for the mode of the run that just ended, captured *before*
 * that run was written. Without it the overlay cannot tell "you beat the record"
 * from "this is the record", because the save is asynchronous and may have
 * landed by the time the first post-game frame draws.
 */
let priorBest = 0;
let showPerf = false;
let seenClear = null;
let banner = '';
let bannerUntil = 0;

/**
 * The best recorded score for a mode.
 *
 * Per mode, because a Marathon score and a 40-line Sprint time are not
 * comparable — showing a Marathon best while playing Sprint would be worse than
 * showing nothing.
 */
function bestFor(modeId) {
  let best = 0;
  for (let i = 0; i < scoreTable.length; i++) {
    const e = scoreTable[i];
    if (e.mode === modeId && e.score > best) best = e.score;
  }
  return best;
}

const panel = makePanel(document.getElementById('settings'), {
  onChange: (next) => { settings = next; applyLive(next); },
  onCommit: (next) => { commitSettings(next); },
  onClose: () => { /* the loop reads panel.isOpen() directly */ },
});

/* ------------------------------------------------------------------ bridge */

function hasBridge() {
  return typeof tiny !== 'undefined' && tiny.api;
}

/**
 * Call a backend method, never throwing.
 *
 * Every bridge call goes through here, and every failure is *reported* rather
 * than swallowed. A silent catch around a bridge call has already cost real time
 * twice on this project: once when a gate denial looked like a hang, and once
 * when it hid the error that explained a blank window.
 */
async function call(method, params) {
  if (!hasBridge()) return null;
  try {
    return await tiny.api.call(method, params);
  } catch (err) {
    report(method + ': ' + (err && err.message ? err.message : String(err)));
    return null;
  }
}

/* ------------------------------------------------------------------ settings */

/** Apply settings to the running game, without touching the seed or the board. */
function applyLive(next) {
  const cfg = settingsToConfig(next);
  setHandling(handling, cfg.handling);
  setTiming(game, cfg.timing);
  // Only when the settings agree with the running mode. On a mode change this
  // runs before the new game starts, and that game sets its own level — applying
  // the new mode's speed to the old mode's board would be a jolt for no reason.
  if (game.mode.id === cfg.mode) setStartLevel(game, cfg.startLevel);
}

/**
 * A setting was committed — the control was released, or a select changed.
 *
 * Only here is anything written to disk: a slider drag fires dozens of `input`
 * events and one `change`.
 */
function commitSettings(next) {
  const modeChanged = next.mode !== settings.mode;
  settings = next;
  applyLive(next);
  call('saveSettings', { settings: captureSettings(settings, handling.cfg, game) });
  // Choosing a mode means playing it, so a mode change starts a run.
  if (modeChanged) newGame(undefined, settings.mode);
}

async function loadSettings() {
  const stored = await call('getSettings');
  settings = normalizeSettings(stored);
  applyLive(settings);
  panel.set(settings);

  const table = await call('getScores');
  if (Array.isArray(table)) scoreTable = table;
}

/* --------------------------------------------------------------------- game */

function newGame(seed, nextMode) {
  // When a mode is being chosen, use *that* mode's speed rather than the one
  // just left behind.
  const target = nextMode || settings.mode;
  const cfg = settingsToConfig(Object.assign({}, settings, { mode: target }));
  // The seed is chosen once per game and recorded, because a replay is a seed
  // plus an input log.
  game = makeGame({
    seed: seed === undefined ? (Date.now() >>> 0) : seed,
    mode: target,
    startLevel: cfg.startLevel,
  });
  setTiming(game, cfg.timing);
  resetHandling(handling);
  setHandling(handling, cfg.handling);
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
  return input.paused === true || panel.isOpen();
}

/* ---------------------------------------------------------------- replays */

/**
 * The run is over: close the log, build the replay, and check it reproduces.
 *
 * The verification re-runs the whole log, which is a few milliseconds — paid
 * once, on the frame the game ended, where a hitch cannot be felt. Worth paying
 * every time: a replay that does not reproduce means something in the simulation
 * has become non-deterministic, and this is the only cheap place to notice.
 */
function finishRun() {
  runRecorded = true;
  finishRecording(recorder);
  lastReplay = buildReplay(game, handling.cfg, recorder.pairs);

  const v = verifyReplay(lastReplay);
  const summary = 'replay: ' + lastReplay.ticks + ' ticks in ' +
    (lastReplay.log.length / 2) + ' pairs, score ' + v.score;
  report(v.ok ? summary + ' — verified'
    : summary + ' — DID NOT VERIFY (' + v.actual + ' vs ' + v.expected + ')');

  const score = lastReplay.result ? lastReplay.result.score : 0;
  // Captured before the write, so the overlay can distinguish beating the record
  // from being the record.
  priorBest = bestFor(lastReplay.mode);
  const best = bestReplay && bestReplay.result ? bestReplay.result.score : -1;
  if (score > best) bestReplay = lastReplay;

  persistRun(lastReplay);
}

/** Write the finished run to disk. Deliberately not awaited by the frame loop. */
async function persistRun(replay) {
  // An abandoned run is still watchable, it is just not a score.
  const entry = scoreEntry(replay, Date.now());
  if (entry) {
    const table = await call('saveScore', { entry });
    if (Array.isArray(table)) scoreTable = table;
  }
  await call('saveReplay', { replay });
}

function watchReplay(replay) {
  if (!replay) {
    report('replay: nothing to watch yet');
    return;
  }
  watch = startPlayback(replay);
  watch.done = false;
  ghost = null;
  seenClear = null;
  banner = '';
}

/** Watch the best replay saved on disk, which exercises the storage round trip. */
async function watchBestSaved() {
  const list = await call('listReplays');
  if (!Array.isArray(list) || !list.length) {
    report('replay: nothing saved yet');
    return;
  }
  const best = list.slice().sort((a, b) => b.score - a.score)[0];
  const replay = await call('loadReplay', { id: best.id });
  if (!replay) return;
  report('replay: loading ' + best.id + ' (' + best.score + ')');
  watchReplay(replay);
}

function toggleGhost() {
  if (ghost) { ghost = null; return; }
  if (watch) return;                     // not while watching a replay
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
  flags.priorBest = priorBest;

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
 * diagnostic anywhere.
 */
function report(msg) {
  if (hasBridge()) {
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
 * choosing a mode, opening settings and watching a replay are driver concerns,
 * not input-handling ones, and a keydown event is already an edge so it needs no
 * latching.
 */
const MODE_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2 };

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  // While the panel is up, the only key the driver owns is the one that closes
  // it. Everything else belongs to the controls.
  if (panel.isOpen()) {
    if (e.code === 'KeyO' || e.code === 'Escape') panel.close();
    return;
  }

  if (e.code === 'KeyO') {
    // Clear held keys before pausing, so nothing is still down on resume.
    resetInput(input);
    panel.open();
    return;
  }
  if (e.code === 'Escape') { watch = null; return; }
  if (e.code === 'KeyV') {
    if (watch) watch = null;
    else watchReplay(lastReplay);
    return;
  }
  if (e.code === 'KeyB') { watchBestSaved(); return; }
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

/* --------------------------------------------------------------------- boot */

newGame();

/**
 * Bench mode, for verifying a change without a human at the keyboard. The
 * backend reports whether TETRIS_BENCH is set in the launcher's environment.
 */
async function maybeBench() {
  if (!hasBridge()) return false;
  const want = await call('bench');
  if (!want) return false;

  // Report *before* anything that can block. The activation below awaits a
  // timer, and a suspended timer in an occluded window never resolves — so
  // without this line a stalled bench run produces no output at all, and
  // "the page never loaded" and "the window was hidden" look identical.
  await call('log', { msg: 'bench: page up, bench flag set' });

  // The pacing half of the self-test needs a *visible* window: WebKit stops rAF
  // when the window is occluded. Bring it to the front, then give it a moment.
  try {
    await tiny.win.show({ activate: true });
    await new Promise((r) => setTimeout(r, 400));
  } catch (err) {
    await call('log', { msg: 'bench: could not activate the window: ' + err });
  }

  // Which display this is running on decides how to read the pacing numbers —
  // and whether the 60 fps cap is in play at all — so record it rather than
  // guessing from the frame rate afterwards.
  const screens = await call('app.screens');
  await call('log', { msg: 'bench: displays ' + JSON.stringify(screens) });

  // A failure here must still quit: otherwise the app hangs and reports nothing,
  // which is exactly how a missing argument turned into a silent 40-second stall.
  try {
    await runSelfTest({
      canvas,
      renderer,
      perf,
      call,
      log: (m) => call('log', { msg: m }),
    });
  } catch (err) {
    await call('log', { msg: 'bench: self-test threw: ' + (err && err.message ? err.message : err) });
  }
  await call('quit');
  return true;
}

async function boot() {
  if (await maybeBench()) return;
  await loadSettings();
  requestAnimationFrame(onFrame);
}

boot();
