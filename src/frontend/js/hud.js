/**
 * The in-game HUD: DOM that floats over the canvas.
 *
 * One button today — Restart — but it lives in its own module for the same
 * reason the menu does: `main.js` wires, it does not build DOM. The conventions
 * are `panel.js`'s: visibility is a class rather than the `hidden` attribute, so
 * a hidden control cannot take focus and swallow a game key.
 *
 * The button is blurred after a click. Without that it keeps focus, and a Space
 * press — the game's hard drop — would activate it a second time instead of
 * dropping the piece. The game's own `keydown` handler also preventDefaults
 * Space, but relying on that ordering would be fragile.
 *
 * Touches `document`, but only inside `makeHud`, so importing this under Node is
 * safe — which is what `test/modules.test.mjs` checks for every module here.
 */

import { el } from './dom.js';

export function makeHud(root, handlers) {
  const onRestart = handlers && handlers.onRestart ? handlers.onRestart : () => {};

  const restart = el('button', 'hud-btn', 'Restart');
  restart.type = 'button';
  restart.title = 'Restart this run (R)';
  restart.addEventListener('click', () => {
    restart.blur();
    onRestart();
  });

  root.appendChild(restart);

  let visible = false;

  function setVisible(next) {
    if (next === visible) return;
    visible = next;
    root.classList.toggle('hud-open', visible);
  }

  setVisible(false);

  return {
    show() { setVisible(true); },
    hide() { setVisible(false); },
    setVisible,
    isVisible() { return visible; },
  };
}
