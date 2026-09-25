/**
 * Sound effects, as waveforms rather than as files.
 *
 * The effects are generated here, at startup, and handed to the sampler as
 * bytes. That is not the obvious design — the obvious one is to commit a
 * directory of `.wav` files and load them by path — and it is worth recording
 * why the obvious one does not work on this platform.
 *
 * `tiny.audio.sampler.load(name, path)` resolves a relative path against the
 * *backend's* working directory, not against the frontend directory, and
 * `app.paths` exposes no frontend or asset key (`home`, `data`, `cache`, `logs`,
 * `temp`, `downloads`, `desktop`, `documents` — that is the whole list). So a
 * relative path resolves under `tinyjs dev` and breaks in the built app, where
 * the frontend is served from a different place. There is also no documented way
 * to exclude a file from the build, and the backend is copied verbatim rather
 * than bundled, so it cannot import a sibling that would compute a path for it.
 *
 * Generating the audio sidesteps all of that: there is no path to resolve, so
 * dev and the packaged app behave identically, and the sounds are reviewable
 * numbers instead of opaque binaries.
 *
 * Pure — no DOM, no `tiny`, no clock, no `Math.random` — so Node can test it,
 * and so `render(name)` is a pure function of the name. Determinism is not
 * decoration here: the noise bursts are seeded, and the tests compare bytes.
 */

import { makeRng } from './rng.js';

/**
 * 22050 Hz mono 16-bit.
 *
 * The sampler decodes to float and mixes in real time, so the rate costs
 * nothing at playback — it only sets how large the source is, and every effect
 * here is a short blip well under the Nyquist limit. Halving the usual 44100
 * halves the startup transfer for no audible difference on square waves.
 */
export const SAMPLE_RATE = 22050;

/** Bytes in a canonical PCM WAV header: everything before the samples. */
export const WAV_HEADER_BYTES = 44;

/** Every effect this module can render, in no particular order. */
export const SFX_NAMES = [
  'lock', 'rotate', 'clear', 'tspin', 'hold', 'harddrop', 'levelup', 'over', 'ui',
];

const TAU = Math.PI * 2;

/* --------------------------------------------------------------- waveforms */

/**
 * One cycle of a waveform, at `phase` turns (0..1).
 *
 * Square is the classic arcade voice and carries the attack well; triangle is
 * the softer one, used where a square would be shrill (a hold swap).
 */
function wave(shape, phase) {
  const t = phase % 1;
  if (shape === 'square') return t < 0.5 ? 1 : -1;
  if (shape === 'triangle') return 4 * Math.abs(t - 0.5) - 1;
  if (shape === 'saw') return 2 * t - 1;
  return Math.sin(t * TAU);
}

/**
 * The amplitude envelope, `t` running 0..1 across the note.
 *
 * The attack ramp is not cosmetic: starting a square wave at full amplitude is
 * a step discontinuity, which is audible as a click. The tail taper does the
 * same job at the other end, and matters more than it looks — a note cut off
 * mid-cycle clicks even if it has decayed a long way.
 */
function envelope(t, attack, decay) {
  const a = attack <= 0 ? 1 : Math.min(1, t / attack);
  const tail = t > 0.95 ? (1 - t) / 0.05 : 1;
  return a * tail * Math.exp(-decay * t);
}

/**
 * Write one note into `buf`, starting at `startMs`.
 *
 * `glideTo` bends the pitch across the note, which is what makes a lock sound
 * like something landing rather than like a beep.
 */
function note(buf, startMs, ms, freq, shape, vol, glideTo, decay) {
  const start = Math.round(startMs * SAMPLE_RATE / 1000);
  const n = Math.round(ms * SAMPLE_RATE / 1000);
  const end = Math.min(buf.length, start + n);
  const glide = glideTo === undefined ? freq : glideTo;
  const d = decay === undefined ? 7 : decay;
  // A fifth of the note for the attack ramp, bounded so a very short blip still
  // spends most of its length at full amplitude.
  const attack = Math.min(0.2, 8 / n);

  let phase = 0;
  for (let i = start; i < end; i++) {
    const t = (i - start) / n;
    phase += (freq + (glide - freq) * t) / SAMPLE_RATE;
    buf[i] += wave(shape, phase) * envelope(t, attack, d) * vol;
  }
}

/**
 * A seeded noise burst, for percussive hits.
 *
 * Seeded rather than random so the bytes are reproducible — a test that
 * compared two renders would otherwise be comparing two different sounds, and
 * the bench could not tell a real change from noise.
 *
 * It shares `envelope` with the notes rather than decaying inline, because the
 * attack ramp matters more here than anywhere else: noise at full amplitude on
 * the first sample is a click, and an inline `exp(-decay * t)` is 1 at t = 0.
 * That is the bug this function was written with the first time.
 */
function noise(buf, startMs, ms, vol, decay) {
  const start = Math.round(startMs * SAMPLE_RATE / 1000);
  const n = Math.round(ms * SAMPLE_RATE / 1000);
  const end = Math.min(buf.length, start + n);
  const rnd = makeRng(0x5eed);
  const attack = Math.min(0.2, 8 / n);

  for (let i = start; i < end; i++) {
    const t = (i - start) / n;
    buf[i] += (rnd() * 2 - 1) * envelope(t, attack, decay) * vol;
  }
}

/* ------------------------------------------------------------------ effects */

/**
 * Each effect fills a buffer of `ms` with notes.
 *
 * `ms` is only the buffer length; the notes inside decide the actual length, so
 * a sound can end early and leave silence. Keeping a little silence on the end
 * is deliberate — it gives the sampler's own fade-out somewhere to happen.
 */
const EFFECTS = {
  /** A piece locks: a low thud that falls in pitch, so it reads as weight. */
  lock: { ms: 90, build: (b) => note(b, 0, 70, 150, 'square', 0.5, 90) },

  /** A rotation: the shortest blip in the bank, and the quietest. */
  rotate: { ms: 60, build: (b) => note(b, 0, 45, 420, 'square', 0.32, 400) },

  /** Lines cleared: a rising two-note, the second longer than the first. */
  clear: {
    ms: 220,
    build: (b) => {
      note(b, 0, 80, 523, 'square', 0.4);
      note(b, 65, 140, 784, 'square', 0.4);
    },
  },

  /**
   * A T-spin: three rising notes instead of two, and a higher top.
   *
   * Deliberately distinct from `clear` rather than a transposition of it — a
   * T-spin is a better outcome than a single line, and the player should be able
   * to hear which one they got without looking.
   */
  tspin: {
    ms: 330,
    build: (b) => {
      note(b, 0, 70, 659, 'square', 0.4);
      note(b, 60, 70, 880, 'square', 0.4);
      note(b, 120, 190, 1046, 'square', 0.42);
    },
  },

  /** Hold: a dull triangle swap, pitched down, so it is not confused with a rotate. */
  hold: { ms: 90, build: (b) => note(b, 0, 70, 300, 'triangle', 0.42, 230) },

  /** Hard drop: a noise burst over a fast low fall — impact plus debris. */
  harddrop: {
    ms: 110,
    build: (b) => {
      noise(b, 0, 55, 0.3, 10);
      note(b, 0, 90, 95, 'square', 0.45, 55, 5);
    },
  },

  /** Level up: a four-note arpeggio, the only ascending run in the bank. */
  levelup: {
    ms: 340,
    build: (b) => {
      note(b, 0, 70, 523, 'square', 0.36);
      note(b, 60, 70, 659, 'square', 0.36);
      note(b, 120, 70, 784, 'square', 0.36);
      note(b, 180, 140, 1046, 'square', 0.4);
    },
  },

  /** The run is over: three descending notes, slow enough to feel like a fall. */
  over: {
    ms: 560,
    build: (b) => {
      note(b, 0, 180, 440, 'square', 0.38, 415, 4);
      note(b, 170, 180, 349, 'square', 0.38, 330, 4);
      note(b, 340, 210, 262, 'square', 0.4, 240, 3.5);
    },
  },

  /** Menu movement and selection: a tick short enough to survive being held down. */
  ui: { ms: 45, build: (b) => note(b, 0, 28, 880, 'square', 0.22) },
};

/* --------------------------------------------------------------- WAV output */

function writeAscii(bytes, at, text) {
  for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
}

/**
 * Wrap float samples in a canonical 16-bit PCM WAV container.
 *
 * The sampler takes encoded audio, not raw samples, so this is the smallest
 * amount of container that gets the samples to it. Every size field is derived
 * from the sample count rather than written by hand, because a header that
 * disagrees with its payload is the classic silent failure here: the file looks
 * fine, decodes to nothing, and reports no error.
 */
export function makeWav(samples) {
  const n = samples.length;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + n * 2);
  const view = new DataView(bytes.buffer);

  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, WAV_HEADER_BYTES - 8 + n * 2, true); // payload + everything after this field
  writeAscii(bytes, 8, 'WAVE');

  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk is 16 bytes
  view.setUint16(20, 1, true); // format 1 = uncompressed PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate: rate * channels * bytes per sample
  view.setUint16(32, 2, true); // block align: channels * bytes per sample
  view.setUint16(34, 16, true); // bits per sample

  writeAscii(bytes, 36, 'data');
  view.setUint32(40, n * 2, true);

  for (let i = 0; i < n; i++) {
    // Clamp before scaling: a note can be layered over another and overshoot,
    // and wrapping instead of clamping turns a loud hit into a loud click.
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(WAV_HEADER_BYTES + i * 2, Math.round(s * 32767), true);
  }
  return bytes;
}

/* ------------------------------------------------------------------- public */

/** Render one named effect to a complete WAV file. Pure — same bytes every time. */
export function render(name) {
  const effect = EFFECTS[name];
  if (!effect) throw new Error('sfxgen: no effect named "' + name + '"');
  const buf = new Float32Array(Math.round(effect.ms * SAMPLE_RATE / 1000));
  effect.build(buf);
  return makeWav(buf);
}

/** Every effect, rendered. One pass at startup, so nothing per-frame allocates. */
export function renderAll() {
  const out = [];
  for (const name of SFX_NAMES) out.push({ name, bytes: render(name) });
  return out;
}
