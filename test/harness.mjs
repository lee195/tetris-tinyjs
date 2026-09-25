/**
 * Minimal assertion harness — no framework, no dependencies.
 *
 * Shared by every test file so the pass/fail summary looks the same everywhere
 * and `npm test` can chain them.
 */

let passed = 0;
let failed = 0;
const failures = [];

export function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(msg); }
}

export function eq(got, want, msg) {
  ok(got === want, msg + ' — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}

export function group(name) {
  console.log('\n' + name);
}

/** Print the summary and exit with a status the shell can read. */
export function done(label) {
  console.log('\n' + '-'.repeat(52));
  if (failed === 0) {
    console.log('PASS — ' + passed + ' assertions' + (label ? ' (' + label + ')' : ''));
  } else {
    console.log('FAIL — ' + failed + ' of ' + (passed + failed) + ' assertions failed:');
    for (const f of failures) console.log('  x ' + f);
  }
  process.exit(failed === 0 ? 0 : 1);
}
