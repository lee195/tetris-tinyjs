# Frame and input-delay measurements

What this project measures about its own responsiveness, how it measures it, and
what the numbers came out to be.

**The numbers below are pinned to the commits that produced them.** They are a
record, not a live readout — re-running the harnesses on different hardware, or
after a change, may produce different values. Each block cites its commit so the
claim stays checkable.

---

## What is measured, and where

| What | Where | Clock | Points sampled | Output |
|---|---|---|---|---|
| Frame interval (`dt`) | `src/frontend/js/loop.js:37`, `main.js:453` | rAF `now` argument | consecutive rAF callbacks | perf ring → overlay / `stats()` |
| Draw duration | `src/frontend/js/render.js:258,356` | `performance.now()` | start and end of `draw()` | `renderer.drawMs` → perf ring |
| Keydown → next frame (real and synthetic) | `test/bench.html:80-94` | `performance.now()` + rAF `t` | keydown stamp → rAF callback | `BENCH` log lines |
| rAF rate and jank | `test/bench.html:89-95,209-212` | rAF `t` | per-frame intervals | `BENCH` log lines |
| Canvas draw cost, full vs cached | `test/bench.html:120-159` | `performance.now()` | 400-iteration loops | `BENCH` log lines |
| Frame pacing under scripted input | `src/frontend/js/selftest.js:273-338,615-653` | rAF `now` | real `draw` + `advance` per frame | `bench:` log lines + `PASS`/`FAIL` |
| Lock → controllable dead time | `test/handling.test.mjs:749-782` | tick counter | ticks, not ms | Node test assertions |

`src/frontend/js/perf.js` is the core of the in-app side: a 600-sample ring
buffer (~10 s at 60 Hz) for frame intervals and draw times, allocation-free, with
`stats()` computing `mean`, `fps`, `p50`, `p99`, `max`, `over33`, `drawP99`,
`drawMax`.

**Input-to-render latency is measured only in the standalone `test/bench.html`.**
The in-app `selftest.js` pacing run measures frame interval and draw time, not
key latency.

---

## Recorded values

### Phase 0 baseline — `70e01fe`

The original self-contained perf harness (now `test/bench.html`; it lived at
`src/frontend/bench.html` at the time) measured:

> measured the 60fps rAF cap, p99 frame interval of 18ms, and a 0.198ms
> full redraw

The 0.198 ms mean is only visible by averaging — see the timer-resolution note
below.

### Phase 3, verified in the real webview — `f4c8e4f`

Run with `TETRIS_BENCH=1 tinyjs dev`. Verbatim from the commit:

```
layout: cell 31px, well 310x620 at (247,10), panel 140px at x=573, dpr 1
fps=60.20 p50=17.0 p99=18.0 max=19.0 >33ms=0 dropped=0
draw_p99=1.00 draw_max=1.00
```

> The no-offscreen-cache decision holds: worst-case draw is under ~1ms against
> a 16.7ms budget.

### Input-delay fix — `bf3b301`

ARE (the appearance delay before the next piece) went from 10 frames to 0, and
the line-clear delay from 20 to 0. "Measured, not guessed":

```
lock -> controllable, no line clear   12 ticks / 200 ms  ->  2 ticks / 33 ms
lock -> controllable, line clear      33 ticks / 550 ms  ->  3 ticks / 50 ms
```

The floor is 2 ticks because the lock and the spawn cannot share a tick; a line
clear costs one more. `test/handling.test.mjs` pins both numbers exactly so a
future change that adds a frame fails loudly instead of being felt.

---

## The pass/fail bar

`meetsBudget()` in `src/frontend/js/perf.js:136`:

```js
return s.over33 === 0 && s.dropped === 0 && s.fps >= 59 && s.drawMax < 8;
```

The bar is **"no missed vsync"**, not "p99 under 16.7 ms" — and that was a
correction, not the original design. The plan asked for `p99 < 16.7 ms`, which a
60 Hz display cannot deliver: intervals are quantised to multiples of ~16.7 ms,
and Phase 0's own baseline had already measured p99 = 18 ms. The criterion
contradicted the measurement it was derived from.

What does mean something is a *doubled* interval. At 60 Hz a missed vsync is a
33 ms frame, which is a doubled input delay — the number that actually matters
for feel. So the gate is: nothing over 33.4 ms, no catch-up clamp, frame rate at
vsync, and the draw inside half a frame. `p99` and `max` are reported but
deliberately not gated.

Separately, the frame loop is ordered for latency: input is applied to the
simulation **before** the tick runs (`src/frontend/js/main.js:1-22`,
`src/frontend/js/apply.js:21`), so a key pressed between two frames is visible in
the frame it arrives rather than the one after. Worst case is one frame
(~16.7 ms), not two.

---

## How to reproduce

**Standalone harness** (rAF rate, keydown→frame latency, canvas draw cost):

```sh
TINYJS_HTML=<abs>/test/bench.html tinyjs dev
```

It must be self-contained — `TINYJS_HTML` materialises the page into a temp dir,
so sibling `<script src>` references silently fail, and the production CSP
forbids inline script. That is why it lives in `test/` and measures only
CSP-independent things.

**In-app bench** (real renderer: pixel readback + frame pacing):

```sh
TETRIS_BENCH=1 TINYJS_DEBUG=1 timeout 60 tinyjs dev
```

**Dead-time regression test** (Node, no framework):

```sh
node --test test/handling.test.mjs
```

**Runtime overlay** — press **P** while the game runs (`main.js:695`). Reports
`fps`, `p50`, `p99`, `max`, `>33ms`, `dropped`, `draw p99`, `draw max`, `ticks`.
The `p99` line turns red at `>= 16.7`.

---

## Known limits

- **Timer resolution.** WebKit coarsens `performance.now()` for security, so draw
  times quantise to roughly 1 ms. A `drawMax` of 1.0 means "under 2 ms", not
  "exactly 1 ms" — enough to show the renderer is nowhere near the 16.7 ms
  budget, not enough to compare two fast paths against each other. Averaging over
  many samples is the only way below the quantum, which is how the 0.198 ms mean
  was obtained.
- **No GPU-present latency is measured anywhere.** Draw duration is the whole
  `draw()` call, not the time to pixels on screen.
- **Input latency is absent from the in-app bench.** Only the standalone
  `bench.html` measures keydown→frame delay.
- **Dead time is counted in ticks, not ms** (`handling.test.mjs`). The ms figures
  come from multiplying by the tick rate; ticks are what keep replays
  deterministic.
- **No results artifact is committed.** The harnesses log to the tinyjs bridge
  and discard their output, so before this file the numbers survived only in git
  history and code comments.
