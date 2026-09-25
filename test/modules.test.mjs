/**
 * Import smoke test.
 *
 *   node test/modules.test.mjs
 *
 * Every other test file imports the modules it needs. This one imports *all* of
 * them, plus the driver, because the failure it guards against is silent and
 * total: a duplicate identifier, a stray syntax error, or a renamed export
 * anywhere in the graph is a load-time error, so the page never executes at all
 * and the launcher prints nothing. The symptom is a blank window with an empty
 * log, which looks exactly like a dozen other problems.
 *
 * This is not hypothetical. Adding a ghost-render check to `selftest.js` reused
 * the identifier `gx`, already declared a few lines above. `node --check` on the
 * driver passed, every test file passed — none of them import `selftest.js` —
 * and the app became a blank window that took three bench runs and a manual
 * import sweep to diagnose.
 *
 * The second half checks the driver's import list against the modules' actual
 * exports, so a rename is caught here rather than as `undefined is not a
 * function` in the webview.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ok, group, done } from './harness.mjs';

/**
 * Every module under `src/frontend/js/`. `main.js` is deliberately absent from
 * this list: it touches the DOM at module scope, so Node cannot import it. It
 * gets the parse check and the import-list check below instead.
 */
const MODULES = [
  'constants', 'rng', 'pieces', 'board', 'rules', 'game', 'loop',
  'handling', 'apply', 'input', 'render', 'perf', 'scoring', 'modes',
  'replay', 'settings', 'panel', 'selftest',
];

const MAIN_PATH = fileURLToPath(new URL('../src/frontend/js/main.js', import.meta.url));

/* --------------------------------------------------------------- loading */

group('every module loads');

for (const name of MODULES) {
  let err = null;
  try {
    await import('../src/frontend/js/' + name + '.js');
  } catch (e) {
    err = e;
  }
  ok(!err, 'js/' + name + '.js imports cleanly' + (err ? ' — ' + err.message : ''));
}

/* ----------------------------------------------------------------- driver */

group('the driver');

{
  let err = null;
  let stderr = '';
  try {
    execFileSync('node', ['--check', MAIN_PATH], { stdio: 'pipe' });
  } catch (e) {
    err = e;
    stderr = String(e.stderr || e.message).split('\n').slice(0, 3).join(' ');
  }
  ok(!err, 'main.js parses as a module' + (err ? ' — ' + stderr : ''));
}

{
  // Read the driver's import list and check every name it asks for actually
  // exists. Self-maintaining: adding an import to main.js extends the test.
  //
  // Every import here is guarded, because the module it is checking may itself
  // fail to load — which is the failure this file exists to report. An
  // unguarded import turns a reportable failure into a crash, and a test that
  // dies with a stack trace is not a test that tells you what is wrong.
  const src = readFileSync(MAIN_PATH, 'utf8');
  const re = /import\s*\{([^}]+)\}\s*from\s*'\.\/([\w.-]+)'/g;
  let m;
  let checked = 0;
  let missing = 0;

  while ((m = re.exec(src)) !== null) {
    let mod = null;
    let loadErr = null;
    try {
      mod = await import('../src/frontend/js/' + m[2]);
    } catch (e) {
      loadErr = e;
    }
    if (loadErr) {
      missing++;
      ok(false, 'main.js imports from ' + m[2] + ', which fails to load — ' + loadErr.message);
      continue;
    }
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const n of names) {
      checked++;
      if (!(n in mod)) {
        missing++;
        ok(false, 'main.js imports ' + n + ' from ' + m[2] + ', which does not export it');
      }
    }
  }

  ok(missing === 0, 'every name the driver imports exists in its module');
  ok(checked >= 20, 'and the import list was actually walked (' + checked + ' names)');
}

/* ------------------------------------------------------------ summary */

done('module loading');
