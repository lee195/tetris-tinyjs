/**
 * The DOM input adapter — events in, an input frame out.
 *
 * This is the only part of the input path that cannot run under Node, so it is
 * kept deliberately mechanical: it maintains booleans and latches and nothing
 * else. Every policy decision (which direction wins, how long DAS is, when a
 * shift repeats) lives in `handling.js`, which is pure and tested.
 *
 * Two things here are easy to get wrong and both are load-bearing:
 *
 *  - **Edges are latched, not sampled.** A key pressed and released between two
 *    ticks must still register as one press; polling `held` alone would drop a
 *    fast tap, which is the most common input in competitive play.
 *  - **Focus loss clears everything.** A `keyup` delivered to another
 *    application never arrives here, so without the blur handler a held
 *    direction stays stuck and the piece drifts forever after a Cmd-Tab.
 */

/**
 * `event.code`, not `event.key`: physical keys, so the layout does not change
 * the controls. Remappable in Phase 4 — this is the default set only.
 */
const KEYMAP = {
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  ArrowDown: 'softDrop',
  KeyS: 'softDrop',
  ArrowUp: 'cw',
  KeyX: 'cw',
  KeyW: 'cw',
  KeyZ: 'ccw',
  Space: 'hardDrop',
  KeyC: 'hold',
  ShiftLeft: 'hold',
  ShiftRight: 'hold',
};

/** Actions that are edges (one press = one action) rather than held state. */
const EDGE_ACTIONS = ['left', 'right', 'cw', 'ccw', 'hardDrop', 'hold'];

export function makeInput() {
  return {
    held: Object.create(null),
    edges: Object.create(null),
    paused: false,
    detach: null,
  };
}

/**
 * Ignore game keys while a text field has focus, so Phase 4's settings inputs
 * are usable. Without this, typing "c" in a name field holds the piece.
 */
function isTyping(e) {
  const t = e.target;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
}

/** Modifier combinations belong to the OS and the browser, not the game. */
function hasModifier(e) {
  return e.metaKey === true || e.ctrlKey === true || e.altKey === true;
}

/**
 * Attach to a target (usually `window`). Returns a detach function.
 *
 * `onFocusLost` is called after the keys are cleared, so the caller can pause.
 */
export function attachInput(input, target, onFocusLost) {
  const win = target || window;

  const onKeyDown = (e) => {
    const action = KEYMAP[e.code];
    if (!action || hasModifier(e) || isTyping(e)) return;
    // Space and the arrows scroll the document by default.
    e.preventDefault();
    // OS auto-repeat is not a game input — the game generates its own repeats
    // from held state, at the configured ARR. Letting the OS in as well would
    // make the rate depend on the system keyboard settings.
    if (e.repeat) return;
    if (!input.held[action]) input.edges[action] = true;
    input.held[action] = true;
  };

  const onKeyUp = (e) => {
    const action = KEYMAP[e.code];
    if (!action || isTyping(e)) return;
    input.held[action] = false;
  };

  const onBlur = () => {
    pauseInput(input);
    if (onFocusLost) onFocusLost();
  };

  // The counterpart to `onBlur`, and the one that used to be missing — see the
  // note on `pauseInput`. Nothing else in the page writes `paused`, which is
  // exactly why a flag whose only writer wrote `true` went unnoticed.
  const onFocus = () => resumeInput(input);

  // Occlusion pauses but does not resume: a window can become visible without
  // becoming focused, and unpausing there would run the game with no keyboard
  // attached to it. `focus` is the only signal that says the player is back.
  const onVisibility = () => {
    if (document.hidden) onBlur();
  };

  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('blur', onBlur);
  win.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);

  const detach = () => {
    win.removeEventListener('keydown', onKeyDown);
    win.removeEventListener('keyup', onKeyUp);
    win.removeEventListener('blur', onBlur);
    win.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
    input.detach = null;
  };
  input.detach = detach;
  return detach;
}

/**
 * Copy the current key state into an input frame, consuming the edge latches.
 *
 * `frame` is caller-supplied and reused, so this allocates nothing — it runs
 * once per simulation tick.
 */
export function pollInput(input, frame) {
  frame.left = input.held.left === true;
  frame.right = input.held.right === true;
  frame.softDrop = input.held.softDrop === true;

  frame.leftEdge = input.edges.left === true;
  frame.rightEdge = input.edges.right === true;
  frame.cwEdge = input.edges.cw === true;
  frame.ccwEdge = input.edges.ccw === true;
  frame.hardEdge = input.edges.hardDrop === true;
  frame.holdEdge = input.edges.hold === true;

  // Consume. Assignment per field rather than a fresh object: no allocation.
  for (let i = 0; i < EDGE_ACTIONS.length; i++) input.edges[EDGE_ACTIONS[i]] = false;

  return frame;
}

/**
 * Drop all key state. Called on focus loss, pause, and new game.
 *
 * Clearing the *latches* as well as the held flags matters: a press that
 * happened just before the window lost focus must not fire on resume.
 */
export function resetInput(input) {
  for (const k in input.held) input.held[k] = false;
  for (let i = 0; i < EDGE_ACTIONS.length; i++) input.edges[EDGE_ACTIONS[i]] = false;
}

/**
 * Focus lost: drop the keys and pause.
 *
 * Exported and pure so the pair can be tested without a DOM. The wiring below is
 * the only part that needs a window — and that wiring is where the bug was:
 * `onBlur` paused and *nothing ever resumed*, so the first Cmd-Tab froze the game
 * for the rest of the session. The two halves now sit together, where a missing
 * counterpart is visible rather than implied.
 */
export function pauseInput(input) {
  resetInput(input);
  input.paused = true;
}

/**
 * Focus regained: drop the keys again and resume.
 *
 * Clearing on the way back in matters as much as on the way out. A key released
 * while another application had focus never delivered its `keyup` here, so the
 * held flags would still claim it is down.
 */
export function resumeInput(input) {
  resetInput(input);
  input.paused = false;
}

export { KEYMAP };
