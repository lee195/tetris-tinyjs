/**
 * The backend's validation surface.
 *
 * `src/main.js` is the one module in the project with full system access, and
 * until now it was the one with no tests: `modules.test.mjs` parse-checks the
 * *frontend* driver and imports every frontend module, and nothing ever loaded
 * the backend. It imports cleanly under Node (nothing at module scope touches
 * `tjs`), and `loadSfx` takes its `app` as an argument, so the validation that
 * guards the bridge can be driven directly with a fake.
 *
 * These target the boundary rather than the happy path — the sizes at which a
 * check flips, and *which* check fires, since that is what reveals an ordering
 * mistake. A validator that rejects the right input for the wrong reason still
 * allocates whatever it was meant to prevent.
 */

import { api, MAX_SFX_BYTES, MAX_SFX_B64 } from '../src/main.js';
import { render, SFX_NAMES } from '../src/frontend/js/sfxgen.js';
import { ok, eq, group, done } from './harness.mjs';

/** An `app` that records what the sampler was handed, and never plays anything. */
function fakeApp() {
  const calls = [];
  return {
    calls,
    audio: {
      sampler: {
        load: async (name, bytes) => { calls.push({ name, bytes }); },
      },
    },
  };
}

/** A WAV-shaped payload of an exact length, so the size boundary can be walked. */
function wavOfLength(n) {
  const base = render('clear');
  const buf = new Uint8Array(n);
  buf.set(base.subarray(0, Math.min(base.length, n)));
  return buf;
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

group('loadSfx — the payload the frontend actually sends');

{
  const app = fakeApp();
  const bytes = render('clear');
  const r = await api.loadSfx({ entries: [{ name: 'clear', bytesB64: b64(bytes) }] }, app);

  eq(r.loaded, 1, 'a generated effect loads');
  eq(r.total, 1, 'total counts the entries offered');
  eq(r.failed, null, 'nothing failed');
  eq(app.calls.length, 1, 'the sampler was called once');
  eq(app.calls[0].name, 'clear', 'under the name it was sent with');
  // The contract between the two halves of the app: what `sfxgen.js` produces
  // must survive the backend's own WAV check, or every sound is rejected.
  eq(app.calls[0].bytes.length, bytes.length, 'byte-for-byte, the same length');
  ok(app.calls[0].bytes[0] === 0x52, 'and still starting with RIFF');
}

group('loadSfx — an oversized payload is refused before it is decoded');

{
  // Valid base64, far over the cap. The decode would succeed; only the size
  // check can reject this, so it proves the cap is reached at all.
  const app = fakeApp();
  const r = await api.loadSfx(
    { entries: [{ name: 'clear', bytesB64: 'A'.repeat(8 * 1024 * 1024) }] }, app);

  eq(r.loaded, 0, 'nothing loads');
  ok(r.failed !== null, 'and it reports a failure');
  ok(String(r.failed).includes('too large'), 'naming the size — got ' + JSON.stringify(r.failed));
  eq(app.calls.length, 0, 'the sampler is never reached');
}

{
  // THE REGRESSION TEST. This payload is oversized *and* not valid base64, so
  // the two possible rejection paths are distinguishable by which one fires.
  //
  // `atob` allocates a decoded string and `b64ToU8` allocates a byte array
  // beside it, so decoding before checking the length pays for the payload
  // twice before deciding it is too big — the cap exists precisely to prevent
  // that, and applying it to the *result* does not. `!` makes the decode throw,
  // so a size verdict here can only come from a check that ran first.
  const app = fakeApp();
  const r = await api.loadSfx(
    { entries: [{ name: 'clear', bytesB64: '!'.repeat(MAX_SFX_B64 + 8) }] }, app);

  ok(String(r.failed).includes('too large'),
    'oversized and undecodable is rejected on size, not on base64 — got ' + JSON.stringify(r.failed));
  eq(app.calls.length, 0, 'and nothing reaches the sampler');
}

group('loadSfx — the two size checks are both load-bearing');

{
  // Exactly at the cap: the encoded length equals the bound, and it decodes to
  // exactly the cap. Accepted.
  const app = fakeApp();
  const r = await api.loadSfx(
    { entries: [{ name: 'clear', bytesB64: b64(wavOfLength(MAX_SFX_BYTES)) }] }, app);
  eq(r.loaded, 1, 'a payload of exactly the cap loads');

  // One byte over. Base64 rounds to groups of three, so this encodes to the
  // *same* character count as the payload above and passes the pre-decode
  // bound — which is why the check on the decoded length has to stay. Removing
  // it as redundant would let this through.
  const app2 = fakeApp();
  const r2 = await api.loadSfx(
    { entries: [{ name: 'clear', bytesB64: b64(wavOfLength(MAX_SFX_BYTES + 1)) }] }, app2);
  eq(r2.loaded, 0, 'one byte over the cap does not');
  eq(app2.calls.length, 0, 'and never reaches the sampler');
}

group('loadSfx — the other refusals, and where the loop stops');

{
  const app = fakeApp();
  const r = await api.loadSfx({ entries: [{ name: 'not a name', bytesB64: b64(render('ui')) }] }, app);
  eq(r.loaded, 0, 'a name outside the slug pattern is refused');
  eq(app.calls.length, 0, 'before the sampler is called');

  const app2 = fakeApp();
  const r2 = await api.loadSfx({ entries: [{ name: 'clear', bytesB64: b64(new Uint8Array(64)) }] }, app2);
  eq(r2.loaded, 0, 'well-formed base64 that is not a WAV is refused');
  ok(String(r2.failed).includes('wav'), 'naming the container — got ' + JSON.stringify(r2.failed));
}

{
  // All-or-nothing, and it stops rather than skipping: a partial bank would
  // silently drop the events whose sounds were missing.
  const app = fakeApp();
  const r = await api.loadSfx({ entries: [
    { name: 'lock', bytesB64: b64(render('lock')) },
    { name: 'rotate', bytesB64: '!'.repeat(MAX_SFX_B64 + 8) },
    { name: 'clear', bytesB64: b64(render('clear')) },
  ] }, app);

  eq(r.loaded, 1, 'the entry before the bad one loaded');
  eq(r.total, 3, 'total still counts all of them');
  ok(String(r.failed).startsWith('rotate'), 'the failure names the offender — got ' + JSON.stringify(r.failed));
  eq(app.calls.length, 1, 'the loop stopped — the entry after it was not loaded');
}

{
  // Distinct from the oversized case on purpose. Both are refusals, but only one
  // of them is about size, and a message that conflates them costs whoever reads
  // it the time to work out which.
  const app = fakeApp();
  const r = await api.loadSfx({ entries: [{ name: 'clear', bytesB64: '' }] }, app);
  eq(r.loaded, 0, 'an empty payload is refused');
  ok(!String(r.failed).includes('too large'),
    'and not described as a size problem — got ' + JSON.stringify(r.failed));

  const app2 = fakeApp();
  const r2 = await api.loadSfx({ entries: [{ name: 'clear' }] }, app2);
  eq(r2.loaded, 0, 'a missing bytesB64 is refused too');
  ok(!String(r2.failed).includes('too large'),
    'also not described as a size problem — got ' + JSON.stringify(r2.failed));
}

{
  let threw = null;
  try { await api.loadSfx({ entries: 'nope' }, fakeApp()); } catch (e) { threw = e; }
  ok(threw !== null, 'a non-array entries throws rather than returning a failure');

  let threw2 = null;
  try {
    const many = [];
    for (let i = 0; i < 17; i++) many.push({ name: 'lock', bytesB64: b64(render('lock')) });
    await api.loadSfx({ entries: many }, fakeApp());
  } catch (e) { threw2 = e; }
  ok(threw2 !== null, 'and so does more entries than the cap allows');
}

group('loadSfx — every name the frontend can send is accepted');

{
  // The two lists live in different files and nothing else ties them together,
  // so a name that the page generates but the backend refuses would silence one
  // event with no error anywhere.
  for (const name of SFX_NAMES) {
    const app = fakeApp();
    const r = await api.loadSfx({ entries: [{ name, bytesB64: b64(render(name)) }] }, app);
    eq(r.loaded, 1, 'the backend accepts the name ' + name);
  }
}

done('backend');
