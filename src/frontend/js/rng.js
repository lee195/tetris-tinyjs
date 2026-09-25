/**
 * Deterministic PRNG and 7-bag randomiser.
 *
 * The whole replay design rests on this: a replay is (seed + input log), and it
 * only reproduces if the piece sequence is a pure function of the seed and the
 * number of pieces drawn. So `next()` must be the ONLY way the queue advances —
 * no `Math.random`, no time, no hidden state.
 *
 * Pure — no DOM, no `tiny` — so Node can test it.
 */

import { PIECE_COUNT } from './constants.js';

/**
 * mulberry32. Small, fast, and fully reproducible from a 32-bit seed.
 * Not cryptographic — it does not need to be, it only has to be deterministic.
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 7-bag: shuffle all seven pieces, deal them, reshuffle. Bounds the worst-case
 * drought to 12 (last of one bag, first of the next).
 */
export function makeBag(seed) {
  const rnd = makeRng(seed);
  const bag = [];
  for (let i = 0; i < PIECE_COUNT; i++) bag.push(i);
  let idx = bag.length; // forces a refill on the first draw

  function refill() {
    // Fisher-Yates, in place — no allocation per bag.
    for (let i = bag.length - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = bag[i];
      bag[i] = bag[j];
      bag[j] = t;
    }
    idx = 0;
  }

  return {
    next() {
      if (idx >= bag.length) refill();
      return bag[idx++];
    },
    /** Pieces left in the current bag, in draw order. For tests and previews. */
    remaining() {
      return bag.slice(idx);
    },
  };
}
