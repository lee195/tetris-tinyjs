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
import { MODE, MODES, MODE_LIST } from './modes.js';
import { makeHandling, makeInputFrame, resetHandling, setHandling } from './handling.js';
import { makeInput, attachInput, pollInput, resetInput, setKeymap } from './input.js';
import { stepWithInput } from './apply.js';
import { makeLoop, advance, resetLoop } from './loop.js';
import {
  makeCountdown, startCountdown, skipCountdown, isCountingDown,
  advanceCountdown, fadeCountdown, countdownLabel, COUNTDOWN_SECONDS,
} from './countdown.js';
import { makeRenderer, draw } from './render.js';
import { makePerf, recordFrame, stats, resetPerf, drawPerf } from './perf.js';
import {
  makeRecorder, recordTick, finishRecording, buildReplay, verifyReplay,
  startPlayback, playbackStep, scoreEntry,
} from './replay.js';
import { normalizeSettings, settingsToConfig, captureSettings } from './settings.js';
import { makePanel } from './panel.js';
import { runSelfTest } from './selftest.js';
import { renderAll } from './sfxgen.js';
import { pick, makeSfx, makeSfxState, resetSfxState } from './sfx.js';
import { makeMenu } from './menu.js';
import { makeHud } from './hud.js';
import { buildItems, keyToAction, confirmKey } from './menuModel.js';

/** How long a "TETRIS" / "T-SPIN DOUBLE" callout stays on screen, in ticks. */
const BANNER_TICKS = 66;

/** How long the just-locked piece flashes for, in ticks. */
const LOCK_FLASH_TICKS = 8;

const canvas = document.getElementById('game');
const renderer = makeRenderer(canvas);
const perf = makePerf();
const perfOut = {};
const loop = makeLoop();
/** The pre-run countdown, owned by the driver rather than the simulation. */
const countdown = makeCountdown();
const input = makeInput();
const frame = makeInputFrame();
const handling = makeHandling(normalizeSettings(null).handling);

/** Reused, never rebuilt — the draw call must not allocate. */
const flags = {
  paused: false, over: false, banner: '', watching: false, ghost: false,
  priorBest: 0, lockFlash: null,
};

/**
 * The cells of the last locked piece, for the flash.
 *
 * Captured on the tick it locked, because once the piece is placed the board
 * cannot say which cells were the newest. Reused, like `flags`.
 */
const lockFlash = { piece: -1, rot: 0, x: 0, y: 0, until: 0 };
const lockFlashView = { piece: -1, rot: 0, x: 0, y: 0, alpha: 0 };

/** The live run. */
let game;
/**
 * Which screen is up: `'title'`, `'playing'`, or `'replay'` — a replay started
 * from the title screen, which Escape returns to the title rather than to the
 * placeholder game behind it.
 *
 * A driver-owned screen rather than a question asked of the overlays. Asking
 * `menu.isOpen()` looks equivalent and is not: the settings panel can be opened
 * *from* the title screen, so closing it would leave no overlay up and the game
 * would begin ticking with no mode ever chosen.
 */
let screen = 'title';
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

/**
 * The title screen.
 *
 * `onClose` is Escape, and it starts the stored mode: a quick play for someone
 * who already knows what they want, and the reason no key on this screen does
 * nothing at all.
 */
const menu = makeMenu(document.getElementById('menu'), {
  onPlay: (modeId) => startMode(modeId),
  onSettings: () => { resetInput(input); panel.open(); },
  onReplays: async () => { menu.showReplays((await call('listReplays')) || []); },
  onWatch: (id) => { watchFromTitle(id); },
  // Escape on the title screen asks before quitting, and this is the answer.
  onQuit: () => { call('quit'); },
});

/**
 * The in-game Restart button. `newGame` gives a fresh board and seed in the same
 * mode, and the countdown plays again — see `newGame`.
 */
const hud = makeHud(document.getElementById('hud'), {
  onRestart: () => newGame(),
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

/* ------------------------------------------------------------------- sound */

/**
 * base64 for a byte array, in chunks.
 *
 * `String.fromCharCode.apply(null, bytes)` on the whole bank overflows the
 * argument limit and throws — and the bank is tens of kilobytes, so it would
 * throw every time. The chunk is the usual 0x8000, comfortably under the limit.
 */
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/**
 * The sampler, wired to the bridge.
 *
 * Every call goes through `call()` rather than `tiny.audio.sampler` directly.
 * The page-side client destructures what the bridge returns, so a denied or
 * failed call rejects — and a rejection raised inside the tick loop is an
 * unhandled rejection once per frame. `call()` reports and returns null instead,
 * which is what the adapter's error path expects.
 */
const sfx = makeSfx({
  load: (entries) => call('loadSfx', {
    entries: entries.map((e) => ({ name: e.name, bytesB64: toB64(e.bytes) })),
  }),
  play: (name, opts) => call('sampler.play', { name, vol: opts.vol, rate: opts.rate }),
  master: (value) => call('sampler.master', { value }),
  stopAll: () => call('sampler.stopAll', {}),
  onError: report,
});

/** Per-tick scratch for the sound decisions — see `pick`. */
const sfxState = makeSfxState();

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

  // Audio is applied here and deliberately is NOT part of `settingsToConfig`.
  // That function produces what the *simulation* needs, and the simulation must
  // not know that sound exists — otherwise volume would become part of the
  // replay config.
  // `volume` is a 0..100 percentage because that is what the slider shows; the
  // sampler's master gain is a 0..1 linear value. Handing it the percentage
  // clamps every position above 0 to full volume, so the control appears dead.
  sfx.setVolume(next.volume / 100);
  sfx.setMuted(next.muted);
  // The keymap is input policy, not simulation config, so it lives here beside
  // audio rather than in `settingsToConfig` — see the note in input.js.
  setKeymap(input, next.keymap);
}

/**
 * A setting was committed — the control was released, a select changed, or a
 * mode key was pressed.
 *
 * Only here is anything written to disk: a slider drag fires dozens of `input`
 * events and one `change`.
 *
 * **The restart decision compares against the running game, not against the
 * settings.** Comparing the new settings with the old ones looks equivalent and
 * is not: if the stored mode is already Sprint and the game is somehow running
 * Marathon, selecting Sprint changes nothing in the settings and the mismatch
 * survives. That is exactly how "I selected sprint and it kept playing
 * marathon" happened — the panel saved Sprint correctly while the game went on.
 */
function commitSettings(next, forceRestart) {
  const modeChanged = next.mode !== game.mode.id;
  settings = next;
  applyLive(next);
  panel.set(settings);
  call('saveSettings', { settings: captureSettings(settings, handling.cfg, game) });
  // Choosing a mode means playing it.
  if (modeChanged || forceRestart) newGame(undefined, next.mode);
}

/**
 * Choose a mode and play it.
 *
 * Always a fresh run, even when the mode did not change. From the title screen
 * the stored mode is usually the one being chosen, and `commitSettings` restarts
 * only on a *change* — so without the force flag, Enter on the mode that is
 * already saved would look like it did nothing at all.
 */
function startMode(modeId) {
  if (!MODES[modeId]) return;
  screen = 'playing';
  menu.close();
  commitSettings(normalizeSettings(Object.assign({}, settings, { mode: modeId })), true);
}

/**
 * Show the title screen.
 *
 * The scores come from the table the driver already holds rather than a fresh
 * fetch: `persistRun` replaces it after every run, so it is current.
 */
function showTitle() {
  screen = 'title';
  watch = null;
  ghost = null;
  startCountdown(countdown, 0);
  menu.set(buildItems(), scoreTable);
  menu.open();
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
  // A key pressed just before a restart must not fire into the new game. Space
  // is a hard drop, and its edge latch survives any stretch of frames where
  // nothing ticks — which is exactly what the title screen and the end-of-run
  // overlay are. Without this, pressing Space to start a game hard-drops the
  // first piece the moment it spawns.
  resetInput(input);
  resetSfxState(sfxState);
  // Hold the run before its first tick. Driver-side only, so the replay contract
  // is untouched — see countdown.js.
  startCountdown(countdown, COUNTDOWN_SECONDS);
  recorder = makeRecorder();
  runRecorded = false;
  // R during a replay from the title screen starts a real run, and a real run
  // must show its Restart button and leave Escape meaning "title".
  if (screen === 'replay') screen = 'playing';
  watch = null;
  ghost = null;
  seenClear = null;
  banner = '';
  bannerUntil = 0;
  lockFlash.until = 0;
}

/**
 * Whether the simulation should hold still.
 *
 * Focus loss, the title screen and the settings panel each stop the clock for a
 * different reason. `flags.paused` below is deliberately narrower, because only
 * one of the three is the canvas's to announce.
 */
function isPaused() {
  return input.paused === true || screen === 'title' || panel.isOpen();
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
  // A replay is not a fresh run, so a countdown left over from the live game
  // must not sit in front of it.
  startCountdown(countdown, 0);
}

/**
 * Watch a saved replay chosen on the title screen.
 *
 * The menu has to close and the screen leave `'title'`, because `isPaused` holds
 * the clock while the title is up — a replay started behind it would never tick.
 */
async function watchFromTitle(id) {
  const replay = await call('loadReplay', { id });
  if (!replay) {
    report('replay: could not load ' + id);
    return;
  }
  screen = 'replay';
  menu.close();
  watchReplay(replay);
}

/** Leave a replay. One started from the title screen goes back to it. */
function stopWatching() {
  watch = null;
  if (screen === 'replay') showTitle();
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

    // The pre-run countdown holds the simulation still. It consumes ticks from
    // the same accumulator, so it is frame-rate independent, and whatever is left
    // over once it ends is spent on the game in this same frame.
    if (ticks > 0 && isCountingDown(countdown)) {
      ticks = advanceCountdown(countdown, ticks);
      // A key pressed during the countdown must not fire into the first tick.
      if (!isCountingDown(countdown)) resetInput(input);
    }
    // Decays the "GO!" window once the run is under way.
    if (ticks > 0) fadeCountdown(countdown, ticks);

    if (ticks > 0 && watch) {
      for (let i = 0; i < ticks && !watch.done; i++) {
        if (!playbackStep(watch)) watch.done = true;
        // A replay is a game being played, so it sounds like one. The ghost is
        // deliberately silent: it advances alongside the live game, so two
        // sounds per event would be noise rather than information.
        sfx.fire(pick(sfxState, watch.game, null));
      }
    } else if (ticks > 0) {
      pollInput(input, frame);
      for (let i = 0; i < ticks; i++) {
        // Before the tick consumes the edges — see the note at the top.
        if (!runRecorded) recordTick(recorder, frame);
        // The piece that may lock on this tick, captured before it is gone: once
        // placed, the board cannot say which cells were the newest, so the lock
        // flash has to remember the piece that produced them.
        const lockBefore = game.lastClear;
        const locked = game.status === STATUS.FALLING && game.piece >= 0;
        const lp = game.piece;
        const lr = game.rot;
        const lx = game.x;
        const ly = game.y;
        // The intent carries what the tick actually applied, which is what the
        // sound decisions read — see the note on the outcome fields in
        // `makeIntent`.
        const it = stepWithInput(game, handling, frame);
        if (locked && game.lastClear !== lockBefore) {
          lockFlash.piece = lp;
          lockFlash.rot = lr;
          lockFlash.x = lx;
          lockFlash.y = ly;
          lockFlash.until = game.ticks + LOCK_FLASH_TICKS;
        }
        sfx.fire(pick(sfxState, game, it));
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
  // Narrower than `isPaused`, on purpose: this is only the pause the *canvas*
  // owns. The title screen and the settings panel announce themselves in the DOM,
  // so painting PAUSED behind them would have the canvas asserting something
  // already said — and it would show through wherever the overlay is not opaque.
  flags.paused = input.paused === true;
  flags.watching = !!watch;
  flags.ghost = !!ghost;
  flags.priorBest = priorBest;
  // Empty string when there is nothing to show; the renderer keys off truthiness.
  flags.countdown = countdownLabel(countdown);

  // The lock flash, while its window is open. Suppressed on a replay: the flash
  // is stamped with the live game's ticks, which the replay's clock does not share.
  if (!watch && shown.ticks < lockFlash.until) {
    lockFlashView.piece = lockFlash.piece;
    lockFlashView.rot = lockFlash.rot;
    lockFlashView.x = lockFlash.x;
    lockFlashView.y = lockFlash.y;
    lockFlashView.alpha = (lockFlash.until - shown.ticks) / LOCK_FLASH_TICKS;
    flags.lockFlash = lockFlashView;
  } else {
    flags.lockFlash = null;
  }

  // The Restart button belongs to a live run, not the title screen, a replay or
  // an open settings panel. `setVisible` memoizes, so this is a comparison per
  // frame, not a DOM write.
  hud.setVisible(screen === 'playing' && !watch && !panel.isOpen());

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

  // The menu claims keys the way the panel does, and the reason is sharper than
  // consistency: with the menu up nothing ticks, so `pollInput` never runs and
  // every edge latch survives the whole time it is open. Without this, `R` would
  // silently restart a run behind the title screen, the number keys would change
  // and persist the mode the title screen is displaying, and `P` would draw the
  // perf overlay across the menu.
  if (menu.isOpen()) {
    // While the quit confirmation is up it owns every key: Enter/Y quit,
    // Escape/N cancel, and O and the mode digits are swallowed so nothing fires
    // behind the prompt. `menu.act` handles the confirm actions; the answer keys
    // are read here because they are not menu-navigation keys.
    if (menu.isConfirming()) {
      const answer = confirmKey(e.code);
      if (answer === 'yes') { menu.confirmQuit(); return; }
      if (answer === 'no') { menu.cancelConfirm(); return; }
      return;
    }
    const action = keyToAction(e.code);
    if (action) { menu.act(action); return; }
    // Settings and the number keys still work from the title screen; everything
    // else belongs to the menu.
    if (e.code === 'KeyO') { resetInput(input); panel.open(); return; }
    const quick = MODE_KEYS[e.code];
    if (quick !== undefined && MODE_LIST[quick]) startMode(MODE_LIST[quick]);
    return;
  }

  // A game key pressed during the countdown starts the run at once. Only the
  // game's own keys skip: O/M/Escape/R and the rest keep their meaning, so a
  // player who wants settings or the title screen during the countdown still
  // gets them. `resetInput` drops the edge `attachInput` just latched, so the
  // skip key cannot also hard-drop the first piece.
  if (isCountingDown(countdown) && input.keymap[e.code]) {
    skipCountdown(countdown);
    resetInput(input);
    return;
  }

  if (e.code === 'KeyO') {
    // Clear held keys before pausing, so nothing is still down on resume.
    resetInput(input);
    panel.open();
    return;
  }
  if (e.code === 'KeyM') {
    // Through commitSettings, so the choice is persisted. A mute that forgets
    // itself on every launch is worse than no mute at all.
    commitSettings(normalizeSettings(Object.assign({}, settings, { muted: !settings.muted })));
    return;
  }
  if (e.code === 'Escape') {
    // Leaving a replay takes precedence: Escape is how playback is stopped, and
    // that is what you mean before you mean "back to the title screen".
    if (watch) { stopWatching(); return; }
    showTitle();
    return;
  }
  if (e.code === 'KeyV') {
    if (watch) stopWatching();
    else watchReplay(lastReplay);
    return;
  }
  if (e.code === 'KeyB') { watchBestSaved(); return; }
  if (e.code === 'KeyG') { toggleGhost(); return; }

  const pick = MODE_KEYS[e.code];
  if (pick !== undefined && MODE_LIST[pick]) {
    // Through startMode, not newGame: pressing 2 must also update the settings,
    // or the panel would go on showing the old mode while the game played the new
    // one — the same mismatch in the other direction.
    startMode(MODE_LIST[pick]);
    return;
  }

  if (e.code === 'Enter' && game.status === STATUS.OVER) newGame();
  else if (e.code === 'KeyR') newGame();
  else if (e.code === 'KeyP') showPerf = !showPerf;
});

/* --------------------------------------------------------------------- boot */

// A game has to exist before anything else can run: `loadSettings` applies the
// stored settings to the running game, so it dereferences `game.mode` before
// `boot` has picked a mode. This is that placeholder — the run the player
// actually plays starts when they choose a mode on the title screen.
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
  //
  // The mode is included because "which mode is actually in play" is a question
  // the settings cannot answer — that gap is what let a mode mismatch hide.
  await call('log', { msg: 'bench: page up, mode ' + game.mode.id + ', bench flag set' });

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
      // The bench loads the bank itself rather than inspecting a load the driver
      // started: it needs to await the load to assert on it, and racing the
      // driver's own fire-and-forget load would make the result a coin toss.
      sfx,
      gen: renderAll,
      // The real menu instance, so the bench checks the element and the class the
      // stylesheet actually keys off rather than a stand-in built for the test.
      menu,
      // And the real hud, for the same reason.
      hud,
    });
  } catch (err) {
    await call('log', { msg: 'bench: self-test threw: ' + (err && err.message ? err.message : err) });
  }
  await call('quit');
  return true;
}

async function boot() {
  // Settings first, so the bench runs against the real configuration and the
  // startup log can report the mode actually in play.
  await loadSettings();

  // The stored mode has to be applied to the *game*, not just to the settings.
  // The module-scope `newGame()` above ran before the settings were read, so
  // without this the first run of every session is Marathon whatever was saved —
  // and selecting the already-saved mode would not fix it, because nothing
  // compared the game's mode against the settings.
  newGame(undefined, settings.mode);

  // The bench loads the bank itself, so it can await the load and assert on the
  // result — loading here first would make that a race.
  if (await maybeBench()) return;

  // The sound bank, generated here and loaded once.
  //
  // Deliberately NOT awaited. On macOS and Windows the mixer is Web Audio inside
  // *this page*, and the backend waits up to fifteen seconds for the page to
  // answer each load before giving up — so awaiting this would freeze the window,
  // with no frames drawn, for however long that took. The game starts first and
  // the sound joins it a moment later. `loadBank` reports its own failures and
  // never rejects, but the catch is here so a future change cannot turn boot into
  // an unhandled rejection.
  sfx.loadBank(renderAll()).catch(() => {});

  // The title screen, not a run. Nothing ticks while it is up, so the placeholder
  // game created at module scope is never stepped — it exists only so that `draw`
  // and `applyLive` have something to read.
  showTitle();

  requestAnimationFrame(onFrame);
}

boot();
