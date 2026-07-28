/* Does the frozen snapshot in selectors.js still match extension-config/selectors.json?
 *
 *   node sync-snapshot.mjs          check, exit 1 on drift
 *   node sync-snapshot.mjs --fix    rewrite the snapshot from the JSON
 *
 * The snapshot exists for one case: a first-ever run with no network and no cache. It is
 * a copy, and copies drift. Drift here is quiet and slow-acting — everything keeps
 * working from remote config, and the staleness only surfaces for a new install that is
 * also offline, which is exactly when nobody is watching.
 *
 * This is not a build step and does not run automatically. It is a check to run after
 * editing the JSON, which is why `--fix` exists.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELECTORS_JS = join(HERE, '..', 'selectors.js');
const CONFIG_JSON = join(HERE, '..', '..', 'extension-config', 'selectors.json');

const json = JSON.parse(readFileSync(CONFIG_JSON, 'utf8'));
const source = readFileSync(SELECTORS_JS, 'utf8');

/* Compare only the fields the extension actually reads. `_comment` and `note` are for
 * humans and are deliberately not mirrored into the snapshot. */
const canonical = (c) => ({
  version: c.version,
  updated: c.updated,
  targets: Object.fromEntries(
    Object.keys(c.targets).sort().map((k) => [
      k,
      {
        critical: Boolean(c.targets[k].critical),
        description: c.targets[k].description,
        selectors: c.targets[k].selectors,
      },
    ]),
  ),
  conversationOpen: c.conversationOpen,
});

const match = source.match(/const FROZEN_CONFIG = (\{[\s\S]*?\n  \};)/);
if (!match) {
  console.error('FAIL: could not find FROZEN_CONFIG in selectors.js');
  process.exit(1);
}

/* eslint-disable no-eval */
const snapshot = eval(`(${match[1].replace(/;$/, '')})`);

const want = JSON.stringify(canonical(json), null, 2);
const have = JSON.stringify(canonical(snapshot), null, 2);

if (want === have) {
  console.log(`OK: frozen snapshot matches selectors.json (version ${json.version})`);
  process.exit(0);
}

console.log('DRIFT between extension-config/selectors.json and the snapshot in selectors.js\n');
console.log('--- selectors.json (source of truth) ---');
console.log(want);
console.log('\n--- frozen snapshot in selectors.js ---');
console.log(have);

if (!process.argv.includes('--fix')) {
  console.log('\nRe-run with --fix to update the snapshot.');
  process.exit(1);
}

const indent = (text, spaces) =>
  text
    .split('\n')
    .map((line, i) => (i === 0 ? line : ' '.repeat(spaces) + line))
    .join('\n');

/* Emit the object as JSON, which is a subset of JavaScript and therefore already a
 * valid object literal.
 *
 * An earlier version prettified it into idiomatic JS by unquoting keys and swapping
 * double quotes for single. That silently corrupted every selector: `[data-tab="10"]`
 * came out as `[data-tab='10']`, because the replace could not tell a string delimiter
 * from a quote inside a CSS attribute selector. The result is still valid CSS and still
 * matches, so nothing broke at runtime — but the snapshot no longer compared equal to
 * its source, and this checker would have reported drift forever afterwards. A
 * "cosmetic" codegen step that quietly rewrites data is not worth quoted-key aesthetics. */
const rendered = indent(JSON.stringify(canonical(json), null, 2), 2);

writeFileSync(
  SELECTORS_JS,
  source.replace(match[1], `${rendered};`),
  'utf8',
);
console.log('\nSnapshot updated. Re-run the evidence harness before committing.');
