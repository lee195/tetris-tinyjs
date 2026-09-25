// The backend. Runs on txiki.js (QuickJS) with full system access.
//
// The game itself is entirely in the page: QuickJS has no JIT, so a hot loop
// here would be orders of magnitude slower than the same code in the webview.
// The rule from the framework's own guidance is "the page computes, the backend
// touches the system", and nothing per-frame may cross the bridge — the board
// never goes over the wire.
//
// So this file holds only persistence: settings, high scores, and replay files.
//
// ## Why files and not `tiny.store`
//
// `store.set` rewrites its entire JSON file on every write, which is fine for a
// small settings blob and wrong for anything that grows. Replays are written as
// one file each, with a small index beside them so listing does not have to read
// every log.
//
// ## Everything from the page is untrusted
//
// The page holds an RPC channel to this process, so a replay id arrives as
// arbitrary data and is used to build a path. Ids are therefore validated
// against a strict pattern rather than merely sanitised — a `../` in a filename
// is a write outside the app's data directory.

const enc = new TextEncoder();
const dec = new TextDecoder();

const SETTINGS_FILE = 'settings.json';
const SCORES_FILE = 'scores.json';
const REPLAY_DIR = 'replays';
const REPLAY_INDEX = 'replays/index.json';

/** How many replays to keep. Pruned best-score-first when exceeded. */
const MAX_REPLAYS = 100;
/** Refuse anything larger; a replay log is a flat list of small integers. */
const MAX_REPLAY_BYTES = 4 * 1024 * 1024;
/** How many score entries to keep per mode. */
const MAX_SCORES_PER_MODE = 25;

/**
 * Sound-bank limits.
 *
 * The effect names are not listed here on purpose. A second copy of the list
 * would be a source of truth that drifts from `sfxgen.js` silently — the frontend
 * is where the names live, and what actually has to hold here is that a name is
 * safe to use as a cache filename component and that the payload is bounded.
 */
const SFX_NAME = /^[a-z][a-z0-9]{0,15}$/;
const MAX_SFX_ENTRIES = 16;
export const MAX_SFX_BYTES = 256 * 1024;
/**
 * The longest base64 string that can still decode to `MAX_SFX_BYTES`.
 *
 * Exported, like the cap above, so `test/backend.test.mjs` can walk the boundary
 * exactly rather than approximately. The launcher reads only `api` and `init`, so
 * the extra names cost nothing.
 */
export const MAX_SFX_B64 = Math.ceil(MAX_SFX_BYTES / 3) * 4;

/**
 * The mode the bench writes probe entries under.
 *
 * Exercising `saveScore` means writing a real entry, and a real player's score
 * table should not accumulate test data. Rather than a destructive "clear" API
 * exposed to the page, every save prunes previous probe entries — so one may
 * linger until the next genuine score, and then it is gone.
 */
const PROBE_MODE = 'selftest';

const join = (a, b) => a + '/' + b;

/**
 * A replay id must be a plain slug. This is the only thing standing between a
 * page-supplied string and an arbitrary path, so it is a strict allow-list
 * rather than a strip-the-bad-characters filter.
 */
function validId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * base64 to bytes. `atob` exists in this runtime; the framework decodes the same way.
 *
 * Deliberately has no size limit of its own — the caller owns the policy. Any
 * caller must therefore bound `str` *before* calling: this allocates twice over,
 * once for the decoded string `atob` returns and once for the byte array, so a
 * check on the result has already paid the cost it was meant to avoid. There is
 * one caller, `loadSfx`, and it checks the encoded length first.
 */
function b64ToU8(str) {
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/**
 * Does this look like a WAV?
 *
 * Worth checking rather than trusting the decode. A payload that is not audio is
 * accepted by the sampler and then plays as *silence*, reporting nothing
 * anywhere — which is the failure this project keeps meeting, a container whose
 * header disagrees with its contents. Rejecting it here is far cheaper than
 * debugging a game that has quietly stopped making noise.
 */
function looksLikeWav(bytes) {
  return bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46   // RIFF
    && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45; // WAVE
}

/** A score entry, reduced to the fields worth keeping. Null when unusable. */
function cleanScore(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.mode !== 'string' || entry.mode.length > 32) return null;
  if (!isFiniteNumber(entry.score) || entry.score < 0) return null;
  return {
    mode: entry.mode,
    score: Math.floor(entry.score),
    lines: isFiniteNumber(entry.lines) ? Math.floor(entry.lines) : 0,
    ticks: isFiniteNumber(entry.ticks) ? Math.floor(entry.ticks) : 0,
    reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 16) : '',
    date: isFiniteNumber(entry.date) ? entry.date : Date.now(),
  };
}

/**
 * The metadata of a replay, without its log.
 *
 * `result` is null for a run that was still going when recording stopped, which
 * is legitimate — an abandoned run is still watchable.
 */
function replayMeta(replay) {
  const r = replay && replay.result ? replay.result : {};
  return {
    id: replay.id,
    mode: typeof replay.mode === 'string' ? replay.mode : 'marathon',
    score: isFiniteNumber(r.score) ? r.score : 0,
    lines: isFiniteNumber(r.lines) ? r.lines : 0,
    ticks: isFiniteNumber(replay.ticks) ? replay.ticks : 0,
    reason: typeof r.reason === 'string' ? r.reason : '',
    date: isFiniteNumber(replay.date) ? replay.date : Date.now(),
  };
}

/** Newest first, best score first within a mode. */
function sortScores(list) {
  return list.slice().sort((a, b) => (b.score - a.score) || (b.date - a.date));
}

function trimScores(list) {
  const byMode = new Map();
  for (const s of list) {
    if (!byMode.has(s.mode)) byMode.set(s.mode, []);
    byMode.get(s.mode).push(s);
  }
  const out = [];
  for (const group of byMode.values()) {
    out.push(...sortScores(group).slice(0, MAX_SCORES_PER_MODE));
  }
  return sortScores(out);
}

/* ------------------------------------------------------------------ storage */

/** The per-app data directory. Not created for us — see `ensureDir`. */
function dataDir(app) {
  return app.paths.data;
}

async function ensureDir(path) {
  // tjs.makeDir is not recursive by default, and the per-app data dir is
  // documented as *not* auto-created.
  try {
    await tjs.makeDir(path, { recursive: true });
  } catch (err) {
    // Already there, which is the normal case.
  }
}

async function readJson(path, fallback) {
  try {
    const data = await tjs.readFile(path);
    return JSON.parse(dec.decode(data));
  } catch (err) {
    // Missing or corrupt both mean "start fresh" — a broken settings file must
    // not make the game unlaunchable.
    return fallback;
  }
}

async function writeJson(path, value) {
  await ensureDir(path.slice(0, path.lastIndexOf('/')));
  await tjs.writeFile(path, enc.encode(JSON.stringify(value)));
  return true;
}

/* ---------------------------------------------------------------------- api */

export const api = {
  /**
   * Whether the launcher was started with TETRIS_BENCH set.
   *
   * The page uses this to run its self-test instead of the game. It exists
   * because there is otherwise no way to verify the real renderer without a
   * human watching the window: the standalone harness page cannot import the
   * game's modules (TINYJS_HTML materialises a page into a temp dir, so sibling
   * imports resolve nowhere).
   */
  async bench() {
    return benchMode();
  },

  /* -- settings -- */

  async getSettings(_params, app) {
    return readJson(join(dataDir(app), SETTINGS_FILE), null);
  },

  async saveSettings({ settings }, app) {
    if (!settings || typeof settings !== 'object') throw new Error('settings: not an object');
    await writeJson(join(dataDir(app), SETTINGS_FILE), settings);
    return true;
  },

  /* -- high scores -- */

  async getScores(_params, app) {
    const list = await readJson(join(dataDir(app), SCORES_FILE), []);
    // Probe entries never reach the page — see PROBE_MODE.
    return Array.isArray(list) ? list.filter((s) => s.mode !== PROBE_MODE) : [];
  },

  /** Records a score and returns the trimmed table, so the page can show it. */
  async saveScore({ entry }, app) {
    const clean = cleanScore(entry);
    if (!clean) throw new Error('score: malformed entry');
    const list = await readJson(join(dataDir(app), SCORES_FILE), []);
    const real = (Array.isArray(list) ? list : []).filter((s) => s.mode !== PROBE_MODE);
    const next = trimScores(real.concat([clean]));
    await writeJson(join(dataDir(app), SCORES_FILE), next);
    return next;
  },

  /* -- replays -- */

  async listReplays(_params, app) {
    const list = await readJson(join(dataDir(app), REPLAY_INDEX), []);
    return Array.isArray(list) ? list : [];
  },

  /**
   * Write a replay and return its index entry.
   *
   * The id is generated here rather than accepted from the page, so the page
   * cannot choose a path. It is returned so the page can load it back.
   */
  async saveReplay({ replay }, app) {
    if (!replay || typeof replay !== 'object') throw new Error('replay: not an object');
    if (!Array.isArray(replay.log)) throw new Error('replay: no log');

    const body = JSON.stringify(replay);
    if (body.length > MAX_REPLAY_BYTES) {
      throw new Error('replay: too large (' + body.length + ' bytes)');
    }

    const id = Date.now().toString(36) + '-' + Math.floor(Math.random() * 1679616).toString(36);
    const stored = Object.assign({}, replay, { id, date: Date.now() });
    await writeJson(join(dataDir(app), REPLAY_DIR) + '/' + id + '.json', stored);

    let index = await readJson(join(dataDir(app), REPLAY_INDEX), []);
    if (!Array.isArray(index)) index = [];
    index.push(replayMeta(stored));

    // Prune best-first, and delete the files that fall off rather than leaving
    // them orphaned.
    const kept = sortScores(index).slice(0, MAX_REPLAYS);
    const keptIds = new Set(kept.map((m) => m.id));
    for (const meta of index) {
      if (!keptIds.has(meta.id) && validId(meta.id)) {
        try {
          await tjs.remove(join(dataDir(app), REPLAY_DIR) + '/' + meta.id + '.json');
        } catch (err) {
          // Already gone; the index is what matters.
        }
      }
    }

    await writeJson(join(dataDir(app), REPLAY_INDEX), kept);
    return replayMeta(stored);
  },

  async loadReplay({ id }, app) {
    if (!validId(id)) throw new Error('replay: bad id');
    return readJson(join(dataDir(app), REPLAY_DIR) + '/' + id + '.json', null);
  },

  async deleteReplay({ id }, app) {
    if (!validId(id)) throw new Error('replay: bad id');
    try {
      await tjs.remove(join(dataDir(app), REPLAY_DIR) + '/' + id + '.json');
    } catch (err) {
      // Already gone.
    }
    let index = await readJson(join(dataDir(app), REPLAY_INDEX), []);
    if (!Array.isArray(index)) index = [];
    await writeJson(join(dataDir(app), REPLAY_INDEX), index.filter((m) => m.id !== id));
    return true;
  },

  /* -- sound -- */

  /**
   * Load the sound bank.
   *
   * The page *generates* the effects — see `sfxgen.js`; there is no path to an
   * asset directory that survives the build, so the sounds are code — and sends
   * the bytes. This hands them to the mixer, which spills them to the app cache
   * and decodes them from there.
   *
   * The page deliberately cannot do this itself. The wire form of `sampler.load`
   * also accepts a *path*, so granting it would let the page name any file on
   * disk for the sampler to read. A method that only accepts bytes the page
   * already holds is strictly weaker, and it is the only thing the page needs.
   *
   * Stops at the first failure rather than trying the rest: if one effect will
   * not load, the cause is almost certainly systemic — no host, no decoder — and
   * every remaining load would spend the same fifteen-second timeout proving it
   * again. Returns `{ loaded, total, failed }` so the page can name what broke.
   *
   * **Two gate entries are required beyond the obvious ones, and no documentation
   * says so.** `sampler.bytes` and `sampler.hostResult` are the Web Audio host's
   * *own* calls — on macOS and Windows that host lives inside the page, so its
   * internal traffic is gated like any other page call. Leave them out and every
   * load fails with "no answer from the main window" after a fifteen-second wait,
   * which reads like a broken sampler rather than a missing policy entry. The
   * bench found this the first time it ran; nothing in the framework's own notes
   * mentions it.
   */
  async loadSfx({ entries }, app) {
    if (!Array.isArray(entries)) throw new Error('loadSfx: entries must be an array');
    if (entries.length > MAX_SFX_ENTRIES) throw new Error('loadSfx: too many entries');

    let loaded = 0;
    let failed = null;
    for (const e of entries) {
      const name = e && typeof e.name === 'string' ? e.name : '';
      if (!SFX_NAME.test(name)) { failed = name || '(unnamed)'; break; }

      // The bound goes on the *encoded* string, before the decode. `atob`
      // allocates the decoded string and `b64ToU8` allocates a byte array
      // beside it, so checking the decoded length instead means paying for an
      // oversized payload twice before deciding it is too big — which is the
      // one thing the cap exists to prevent.
      const b64 = typeof e.bytesB64 === 'string' ? e.bytesB64 : '';
      // Two conditions, two messages: an empty payload is a malformed request
      // and an oversized one is a policy refusal, and "too large" for a missing
      // field would send the next reader looking for a size bug that is not there.
      if (!b64) {
        failed = name + ' (no bytes)';
        break;
      }
      if (b64.length > MAX_SFX_B64) {
        failed = name + ' (too large)';
        break;
      }

      let bytes;
      try {
        bytes = b64ToU8(b64);
      } catch (err) {
        failed = name + ' (bad base64)';
        break;
      }
      // Kept as well as the check above, and not redundantly: base64 spends four
      // characters per three bytes, so the encoded bound rounds *up* and admits
      // a payload up to two bytes over the cap. That check bounds the memory a
      // rejected payload can cost; this one is the authority on the size.
      if (!bytes.length || bytes.length > MAX_SFX_BYTES || !looksLikeWav(bytes)) {
        failed = name + ' (not a usable wav)';
        break;
      }

      try {
        await app.audio.sampler.load(name, bytes);
      } catch (err) {
        failed = name + ' (' + (err && err.message ? err.message : String(err)) + ')';
        break;
      }
      loaded++;
    }

    return { loaded, total: entries.length, failed };
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
