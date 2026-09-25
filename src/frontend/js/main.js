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
 * One subtlety worth stating, because it is easy to "fix" into a bug:
 * **input is polled only on frames that actually run a tick.** `pollInput`
 * consumes the edge latches, so polling on a frame where the accumulator yields
 * zero ticks would silently swallow a press. Leaving the latches in place means
 * they are picked up by the next frame that ticks — which is correct, since
 * there was no simulation step for the press to apply to.
 */

import { TICK_MS } from './constants.js';
import { makeGame, STATUS, setLevel } from './game.js';
import { makeHandling, makeInputFrame, resetHandling, DEFAULT_HANDLING } from './handling.js';
import { makeInput, attachInput, pollInput } from './input.js';
import { stepWithInput } from './apply.js';
import { makeLoop, advance, resetLoop } from './loop.js';
import { makeRenderer, draw } from './render.js';
import { makePerf, recordFrame, stats, resetPerf, drawPerf } from './perf.js';
import { runSelfTest } from './selftest.js';

/** Lines per level. Provisional — the real curve is Phase 4's scoring work. */
const LINES_PER_LEVEL = 10;

const canvas = document.getElementById('game');
const renderer = makeRenderer(canvas);
const perf = makePerf();
const perfOut = {};
const loop = makeLoop();
const input = makeInput();
const frame = makeInputFrame();
const handling = makeHandling(DEFAULT_HANDLING);

/** Reused, never rebuilt — the draw call must not allocate. */
const flags = { paused: false, over: false };

let game;
let showPerf = false;

function newGame(seed) {
  // The seed is chosen once per game and kept on the state, because a replay is
  // a seed plus an input log — Phase 4 records it.
  game = makeGame({ seed: seed === undefined ? (Date.now() >>> 0) : seed });
  resetHandling(handling);
  resetLoop(loop);
  resetPerf(perf);
}

/** Focus loss pauses. The input adapter has already cleared the held keys. */
function isPaused() {
  return input.paused === true;
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
    if (ticks > 0) {
      pollInput(input, frame);
      for (let i = 0; i < ticks; i++) {
        stepWithInput(game, handling, frame);
        if (game.status === STATUS.OVER) break;
      }
    }
  }

  flags.over = game.status === STATUS.OVER;

  // Provisional level curve, so the renderer has something to show and the game
  // can be played at speed. Phase 4 replaces this with real scoring.
  const wantLevel = 1 + Math.floor(game.lines / LINES_PER_LEVEL);
  if (wantLevel !== game.level) setLevel(game, wantLevel);

  flags.paused = isPaused();
  draw(renderer, game, flags);
  recordFrame(perf, dt, renderer.drawMs, ticks, loop.dropped !== droppedBefore);

  if (showPerf) {
    stats(perf, perfOut);
    drawPerf(renderer.ctx, perfOut, perf, renderer.drawMs, 12, 12);
  }

  requestAnimationFrame(onFrame);
}

/* ------------------------------------------------------------------- wiring */

/**
 * Report an uncaught page error to the launcher's stdout.
 *
 * Without this an exception in the frame loop is *invisible*: `console.log` is
 * not forwarded from the page, so the game would simply stop animating with no
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

// Game lifecycle keys are handled here rather than in the game's key map:
// restarting is a driver concern, not an input-handling one, and a keydown
// event is already an edge so it needs no latching.
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
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
