// The backend. Runs on txiki.js (QuickJS) with full system access.
//
// The game itself is entirely in the page: QuickJS has no JIT, so a hot loop
// here would be orders of magnitude slower than the same code in the webview.
// The rule from the framework's own guidance is "the page computes, the backend
// touches the system", and nothing per-frame may cross the bridge — the board
// never goes over the wire.
//
// So this file is deliberately almost empty. Phase 4 adds persistence here:
// settings, high scores, and replays (as individual files via tjs.writeFile,
// not tiny.store, which rewrites its whole JSON file on every write).

export const api = {
  /**
   * Whether the launcher was started with TETRIS_BENCH set.
   *
   * The page uses this to run its self-test instead of the game — drawing known
   * states and reading the pixels back, plus a scripted frame-pacing burst. It
   * exists because there is otherwise no way to verify the real renderer without
   * a human watching the window: the standalone harness page cannot import the
   * game's modules (TINYJS_HTML materialises a page into a temp dir, so sibling
   * imports resolve nowhere).
   *
   * Not a capability — it grants no access — but it is still gated by name in
   * tinyjs.json, because the gate is deny-by-default and an ungated method is
   * an ungated method.
   */
  async bench() {
    return benchMode();
  },
};

function benchMode() {
  return String(tjs.env.TETRIS_BENCH || '') !== '';
}

/**
 * Bench watchdog.
 *
 * This has to live in the backend, not the page. The self-test's slow half
 * measures frame pacing, which needs requestAnimationFrame — and WebKit stops
 * rAF *and* suspends timers when the window is occluded. So a page-side timeout
 * cannot rescue a stalled run: if the window is behind another, the page never
 * wakes up to notice. This process is not throttled, so the bound belongs here.
 *
 * Without it a bench run launched from a background shell hangs until something
 * external kills it, and reports nothing at all.
 */
export function init(app) {
  if (!benchMode()) return;
  const limitMs = Number(tjs.env.TETRIS_BENCH_TIMEOUT || 40000);
  setTimeout(() => {
    console.log('[bench] watchdog fired after ' + limitMs + 'ms — the page did not ' +
      'finish. If it stalled at the pacing measurement, the window was occluded.');
    app.quit();
  }, limitMs);
}
