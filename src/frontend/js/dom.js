/**
 * The one DOM helper the overlays share.
 *
 * `panel.js` had this privately, and the menu needed the same thing. Rather than
 * a second copy, it lives here — the project's habit is one home for a convention
 * (`encodeHandling` is the single home for the Infinity encoding), and a
 * duplicated helper is how two overlays quietly start behaving differently.
 *
 * Touches `document`, but only inside the function, so importing this under Node
 * is safe — which is what `test/modules.test.mjs` checks for every module here.
 */

/**
 * An element, with an optional class and text.
 *
 * `textContent`, never `innerHTML`. The page holds an RPC channel to a process
 * with full system access, so anything interpolated into markup is a way to reach
 * it — and none of what these overlays render needs markup anyway.
 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
