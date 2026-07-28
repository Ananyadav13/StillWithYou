/* Track B / Step B3 — does the malformed-config fallback hold against the LIVE CDN?
 *
 *   node run-live-malformed-check.mjs
 *
 * The bug this guards was found by the local harness: a reachable-but-invalid config
 * originally returned `unavailable` without consulting the cache, so ONE bad push
 * dropped every client to the frozen snapshot — while merely being offline correctly
 * kept last-known-good. Backwards, since a bad push is both likelier and more in need of
 * a limited blast radius.
 *
 * This re-runs that test end to end against real GitHub rather than a local server:
 *
 *   1. fetch the GOOD config from main      -> expect source=remote, cache written
 *   2. fetch the MALFORMED config from a test branch, sharing that same cache
 *                                            -> expect source=cache, NOT unavailable
 *   3. confirm the good cache entry was not overwritten by the garbage
 *
 * The malformed file lives on a throwaway branch and is never merged, so `main` never
 * serves a broken config even briefly.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..');
const RAW = 'https://raw.githubusercontent.com/Ananyadav13/StillWithYou';
const GOOD_URL = `${RAW}/main/extension-config/selectors.json`;
const BAD_URL = `${RAW}/test/malformed-config/extension-config/selectors.json`;

const src = readFileSync(join(EXT, 'config_source.js'), 'utf8');
const withUrl = (u) =>
  `data:text/javascript;base64,${Buffer.from(
    src.replace(/const CONFIG_URL =\s*\n?\s*'[^']*';/, `const CONFIG_URL = '${u}';`),
  ).toString('base64')}`;

/* ONE shared store across both module instances — this is the point. In the real
 * extension there is one chrome.storage.local, so the malformed fetch must be able to
 * see the cache the good fetch wrote. */
let store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: (k, cb) => cb(store),
      set: (o, cb) => { Object.assign(store, o); if (cb) cb(); },
    },
  },
  runtime: { lastError: undefined },
};

const results = [];
const check = (label, passed, detail = '') => {
  results.push({ label, passed });
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

console.log('='.repeat(88));
console.log('TRACK B / STEP B3 — malformed config against the LIVE GitHub CDN');
console.log('='.repeat(88));
console.log(`  good: ${GOOD_URL}`);
console.log(`  bad:  ${BAD_URL}`);
console.log(`  run:  ${new Date().toISOString()}\n`);

/* Sanity: the malformed file really is being served, and really is malformed. */
const rawBad = await (await fetch(BAD_URL, { cache: 'reload' })).json();
console.log(`  test branch serves version ${rawBad.version}, ` +
  `composeBox.selectors=${JSON.stringify(rawBad.targets.composeBox.selectors)}, ` +
  `sendButton=${rawBad.targets.sendButton ? 'present' : 'MISSING'}, ` +
  `conversationOpen=${rawBad.conversationOpen ? 'present' : 'MISSING'}\n`);

/* --- 1. good config from main -------------------------------------------- */
const { loadConfig: loadGood } = await import(withUrl(GOOD_URL));
const good = await loadGood({ force: true });
console.log(`  [1] main      -> source=${good.source} version=${good.version} (${good.elapsedMs}ms)`);
check('good config fetched from live main', good.source === 'remote', good.source);
check('cache written', Boolean(store.remote_selector_config), '');
const cachedVersion = store.remote_selector_config?.config?.version;

/* --- 2. malformed config from the test branch ----------------------------- */
const { loadConfig: loadBad } = await import(withUrl(BAD_URL));
const bad = await loadBad({ force: true });
console.log(`  [2] test/…    -> source=${bad.source} version=${bad.version} reason=${bad.reason} (${bad.elapsedMs}ms)`);

check('falls back to CACHE, not unavailable', bad.source === 'cache', bad.source);
check('rejection reason names the validation failure',
  typeof bad.reason === 'string' && bad.reason.startsWith('invalid:'), bad.reason);
check('served config is the last-known-good version', bad.version === cachedVersion,
  `${bad.version} vs cached ${cachedVersion}`);
check('garbage NOT written to cache',
  store.remote_selector_config?.config?.version === cachedVersion,
  `cache still v${store.remote_selector_config?.config?.version}`);
check('served config has usable selectors',
  Array.isArray(bad.config?.targets?.composeBox?.selectors) &&
  bad.config.targets.composeBox.selectors.length > 0,
  `${bad.config?.targets?.composeBox?.selectors?.length} selectors`);

const passed = results.filter((r) => r.passed).length;
console.log(`\n  ${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
