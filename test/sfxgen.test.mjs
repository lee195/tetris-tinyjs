/**
 * Headless tests for the sound-effect synthesiser.
 *
 *   node test/sfxgen.test.mjs
 *
 * The container is where this fails silently. A WAV whose header disagrees with
 * its payload decodes to nothing and reports no error anywhere — the sampler
 * loads it happily and plays silence — so the size fields are checked against
 * the actual byte length rather than against each other, which would only prove
 * the header is self-consistent.
 *
 * The rest is the part a listener could not tell you: that generation is
 * deterministic (the tests and the bench both compare bytes, and would be
 * comparing different sounds otherwise), that the effects are actually distinct
 * from one another, and that none of them clips.
 */

import {
  render, renderAll, makeWav, SAMPLE_RATE, SFX_NAMES, WAV_HEADER_BYTES,
} from '../src/frontend/js/sfxgen.js';
import { ok, eq, group, done } from './harness.mjs';

const dec = new TextDecoder();

/** The 4-byte tag at `at`, as ASCII. */
function tag(bytes, at) {
  return dec.decode(bytes.subarray(at, at + 4));
}

/** Samples as signed 16-bit, for measuring rather than for listening. */
function samples(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = (bytes.length - WAV_HEADER_BYTES) / 2;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(WAV_HEADER_BYTES + i * 2, true);
  return out;
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function peak(bytes) {
  const s = samples(bytes);
  let max = 0;
  for (let i = 0; i < s.length; i++) {
    const a = s[i] < 0 ? -s[i] : s[i];
    if (a > max) max = a;
  }
  return max;
}

/* ---------------------------------------------------------------- container */

group('the WAV container');

{
  const bytes = render('lock');
  const v = view(bytes);

  eq(tag(bytes, 0), 'RIFF', 'starts with the RIFF tag');
  eq(tag(bytes, 8), 'WAVE', 'declares the WAVE form');
  eq(tag(bytes, 12), 'fmt ', 'has a fmt chunk');
  eq(tag(bytes, 36), 'data', 'and a data chunk at the canonical offset');

  // The sizes are derived from the payload, so check them against the payload —
  // not against the constants they were computed from.
  const payload = bytes.length - WAV_HEADER_BYTES;
  eq(v.getUint32(4, true), bytes.length - 8, 'the RIFF size covers everything after its own field');
  eq(v.getUint32(16, true), 16, 'the fmt chunk is the canonical 16 bytes');
  eq(v.getUint32(40, true), payload, 'the data size matches the actual payload');
  ok(payload > 0, 'and the payload is not empty');
  eq(payload % 2, 0, 'the payload is a whole number of 16-bit samples');

  eq(v.getUint16(20, true), 1, 'the format is uncompressed PCM');
  eq(v.getUint16(22, true), 1, 'it is mono');
  eq(v.getUint32(24, true), SAMPLE_RATE, 'the sample rate is the module constant');
  eq(v.getUint16(34, true), 16, 'the samples are 16-bit');

  // These two are derivable from the fields above, which is exactly why they are
  // worth asserting: a player that trusts byteRate instead of walking the
  // samples gets the wrong duration if they disagree.
  eq(v.getUint32(28, true), SAMPLE_RATE * 2, 'the byte rate agrees with mono 16-bit');
  eq(v.getUint16(32, true), 2, 'and so does the block align');
}

{
  // makeWav on a known input, so the container is tested independently of the
  // effects. Silence is the sharpest case: every sample must land on zero, and
  // an off-by-one in the sample offset would show up as a shifted payload.
  const wav = makeWav(new Float32Array([0, 1, -1, 0.5]));
  const s = samples(wav);
  eq(s.length, 4, 'four samples in, four samples out');
  eq(wav.length, WAV_HEADER_BYTES + 8, 'and the file is the header plus two bytes each');
  eq(s[0], 0, 'silence stays silent');
  eq(s[1], 32767, 'full scale positive maps to the 16-bit maximum');
  eq(s[2], -32767, 'and negative to the minimum');
  eq(s[3], 16384, 'and half scale rounds to half of the maximum');

  // Clamping, not wrapping. Wrapping turns an over-loud hit into a loud click.
  const loud = samples(makeWav(new Float32Array([2, -2])));
  eq(loud[0], 32767, 'an overshooting sample clamps rather than wrapping');
  eq(loud[1], -32767, 'at both ends');
}

/* ------------------------------------------------------------------ effects */

group('the effects');

{
  for (const name of SFX_NAMES) {
    let bytes = null;
    let err = null;
    try { bytes = render(name); } catch (e) { err = e; }
    ok(!err, 'render(' + name + ') produces a file' + (err ? ' — ' + err.message : ''));
    if (!bytes) continue;

    const p = peak(bytes);
    // Two failures in one assertion: a peak of zero is a sound nobody can hear,
    // and a peak at full scale means the mix clipped.
    ok(p > 3000 && p < 32767,
      name + ' is audible without clipping  [peak ' + p + ']');

    // The attack ramp is what this catches. Without it the envelope is 1 at
    // t = 0 and the file opens on a step discontinuity, which is a click.
    const s = samples(bytes);
    eq(s[0], 0, name + ' opens at zero amplitude, so it does not click');
    eq(s[s.length - 1], 0, name + ' closes at zero amplitude too');
  }
}

{
  let threw = null;
  try { render('nonexistent'); } catch (e) { threw = e; }
  ok(threw !== null, 'an unknown effect name throws rather than returning silence');
  ok(threw && /nonexistent/.test(threw.message), 'and the message names the effect');
}

{
  // Every effect must be a *different* sound. A copy-paste in the effect table
  // would otherwise ship two identical effects and nothing would notice.
  const seen = new Map();
  let distinct = true;
  let clash = '';
  for (const name of SFX_NAMES) {
    const bytes = render(name);
    const key = bytes.length + ':' + Array.from(bytes.subarray(0, 64)).join(',');
    if (seen.has(key)) { distinct = false; clash = seen.get(key) + ' and ' + name; }
    else seen.set(key, name);
  }
  ok(distinct, 'no two effects render to the same audio' + (clash ? ' — ' + clash : ''));
}

{
  // Determinism is load-bearing, not decoration: the noise bursts are seeded,
  // and a test or a bench that compared two renders would be comparing two
  // different sounds if it were not.
  let identical = true;
  for (const name of SFX_NAMES) {
    const a = render(name);
    const b = render(name);
    if (a.length !== b.length) { identical = false; break; }
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { identical = false; break; }
    if (!identical) break;
  }
  ok(identical, 'rendering the same effect twice gives byte-identical audio');
}

{
  const all = renderAll();
  eq(all.length, SFX_NAMES.length, 'renderAll covers every name');
  let ordered = true;
  for (let i = 0; i < all.length; i++) if (all[i].name !== SFX_NAMES[i]) ordered = false;
  ok(ordered, 'and returns them in the declared order, each with its bytes');
  ok(all.every((e) => e.bytes instanceof Uint8Array && e.bytes.length > WAV_HEADER_BYTES),
    'every entry carries a non-empty Uint8Array');

  let total = 0;
  for (const e of all) total += e.bytes.length;
  // The bank crosses the bridge once, as base64, at startup. If this ever grows
  // past a few hundred KB the transfer becomes worth rethinking, so pin it.
  ok(total < 200 * 1024, 'the whole bank stays small enough for one startup transfer  [' +
    Math.round(total / 1024) + ' KB]');
}

/* --------------------------------------------------------------- purity */

group('purity');

{
  // The module must not reach for a clock or for real randomness, or two runs
  // would differ and the determinism assertion above would be luck.
  //
  // Comments are stripped first, and that is not a detail: the source explains
  // *why* the noise is seeded by naming the thing it does not use, so a naive
  // grep matches the prose that documents the rule it is checking.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/frontend/js/sfxgen.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(code.length > 0, 'the comment stripper left something to check');
  ok(!/Math\.random/.test(code), 'no Math.random');
  ok(!/\bDate\b|performance\.now/.test(code), 'no clock');
  ok(!/\btiny\b|\bdocument\b|\bwindow\b/.test(code), 'no tiny, DOM or window outside comments');
}

done('sfxgen');
