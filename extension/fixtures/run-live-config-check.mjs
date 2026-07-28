/* Track B — verify the remote selector config against the LIVE GitHub CDN.
 *
 *   node run-live-config-check.mjs            B1: fetch, validate, cache, install
 *   node run-live-config-check.mjs --watch     B2: poll until a pushed edit appears
 *   node run-live-config-check.mjs --url <u>   B3: point at a branch URL
 *
 * Unlike run-config-evidence.mjs, which serves config from a local HTTP server so a
 * mid-run edit is testable, this hits raw.githubusercontent.com for real. It runs the
 * shipping `config_source.js` unmodified (except for --url), which is exactly what the
 * MV3 service worker executes, and then installs the result into the real
 * `selectors.js` / `remote_config.js` inside headless Chrome.
 *
 * What this still does NOT cover: that Chrome grants the fetch under the manifest's
 * `host_permissions`. That needs the extension actually loaded, and is the one part of
 * B1 that has to be captured in a browser.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const read = (n) => readFileSync(join(EXT, n), 'utf8');

const urlArg = process.argv.indexOf('--url');
const OVERRIDE_URL = urlArg > -1 ? process.argv[urlArg + 1] : null;
const WATCH = process.argv.includes('--watch');
const EXPECT_VERSION = (() => {
  const i = process.argv.indexOf('--expect-version');
  return i > -1 ? Number(process.argv[i + 1]) : null;
})();

let src = read('config_source.js');
if (OVERRIDE_URL) {
  src = src.replace(/const CONFIG_URL =\s*\n?\s*'[^']*';/, `const CONFIG_URL = '${OVERRIDE_URL}';`);
}
const LIVE_URL = src.match(/const CONFIG_URL =\s*\n?\s*'([^']*)'/)[1];

const mod = `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
const { loadConfig } = await import(mod);

/* chrome.storage.local stand-in, so the cache tier is exercised for real. */
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

console.log('='.repeat(88));
console.log('TRACK B — live GitHub CDN check');
console.log('='.repeat(88));
console.log(`  url:    ${LIVE_URL}`);
console.log(`  run at: ${new Date().toISOString()}`);
console.log('');

if (WATCH) {
  /* B2: poll until the pushed version appears, and report real propagation time. */
  const startedAt = Date.now();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const r = await loadConfig({ force: true });
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `  [${new Date().toISOString()}] attempt ${String(attempt).padStart(2)} ` +
        `t+${elapsed.padStart(6)}s  source=${r.source}  version=${r.version}`,
    );
    if (EXPECT_VERSION !== null && r.version === EXPECT_VERSION) {
      console.log(`\n  PROPAGATED: version ${EXPECT_VERSION} visible after ${elapsed}s`);
      break;
    }
    if (Date.now() - startedAt > 15 * 60 * 1000) {
      console.log('\n  gave up after 15 minutes');
      break;
    }
    await new Promise((r2) => setTimeout(r2, 15000));
  }
  process.exit(0);
}

/* --- single fetch --------------------------------------------------------- */
const result = await loadConfig({ force: true });
console.log('  loadConfig() ->');
console.log(`    source:      ${result.source}`);
console.log(`    version:     ${result.version}`);
console.log(`    reason:      ${result.reason ?? '(none)'}`);
console.log(`    elapsed_ms:  ${result.elapsedMs}`);
console.log(`    cached_at:   ${result.cachedAt ?? '(fresh)'}`);
console.log(`    cache write: ${store.remote_selector_config ? 'yes' : 'no'}`);
if (result.config) {
  console.log(`    composeBox:  ${result.config.targets.composeBox.selectors.length} selectors`);
}
console.log('');

/* --- install it into the real content-script code ------------------------- */
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[StillWithYou]')) { logs.push(t); if (t.includes('config_source')) console.log(`  ${t}`); }
});
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message)));

await page.goto(`file://${join(HERE, 'whatsapp-fixture.html').replace(/\\/g, '/')}`);
await page.evaluate(() => {
  window.__swyStorage = {};
  window.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (msg, cb) => {
        if (msg && msg.type === 'SWY_CONFIG') { window.__swyConfigBridge(true).then(cb); return; }
        cb({ ok: false, reason: 'unreachable' });
      },
    },
    storage: { local: {
      get: (k, cb) => cb(window.__swyStorage),
      set: (o, cb) => { Object.assign(window.__swyStorage, o); if (cb) cb(); },
    } },
  };
});
await page.addStyleTag({ content: read('banner.css') });
for (const f of ['config.js', 'selectors.js', 'remote_config.js', 'health_check.js', 'banner.js']) {
  await page.addScriptTag({ content: read(f) });
}
await page.exposeFunction('__swyConfigBridge', async () => loadConfig({ force: true }));
await page.addScriptTag({ content: read('content.js') });
await new Promise((r) => setTimeout(r, 2500));

const source = await page.evaluate(() => window.SWY.selectors.source);
const version = await page.evaluate(() => window.SWY.selectors.version);
const health = await page.evaluate(() => window.SWY.health.inspect().state);

console.log('');
console.log(`  extension state after install:`);
console.log(`    selectors.source:  ${source}`);
console.log(`    selectors.version: ${version}`);
console.log(`    health:            ${health}`);
console.log(`    page errors:       ${pageErrors.length === 0 ? 'none' : pageErrors.join('; ')}`);

const ok = source === 'remote' && pageErrors.length === 0;
console.log(`\n  ${ok ? 'PASS' : 'FAIL'}: config_source is "${source}" against the live CDN`);

await browser.close();
process.exit(ok ? 0 : 1);
