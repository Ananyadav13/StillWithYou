/* Reproduce the live "draft_capture goes silent" regression.
 *
 *   node run-capture-regression.mjs [--api http://127.0.0.1:8000]
 *
 * The 69-check harness does not catch this, and the reason is the point: it stubs the
 * config bridge to `unavailable`, so `remoteConfig.onInstalled` never fires and the
 * `config_applied` path is never exercised. On the real site that path DOES run, about a
 * second after load, and it sets `attachedBox = null`.
 *
 * This runs the same shipping files with the REAL remote config fetched from GitHub, then
 * types, and reports whether draft_captured fires. Scenario B repeats it with the config
 * bridge stubbed out, so the difference isolates the config path rather than merely
 * showing that something is broken.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

import { analyzePreview } from '../api.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const apiArg = process.argv.indexOf('--api');
const API = apiArg > -1 ? process.argv[apiArg + 1] : 'http://127.0.0.1:8000';
const read = (n) => readFileSync(join(EXT, n), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfgSrc = read('config_source.js');
const { loadConfig } = await import(
  `data:text/javascript;base64,${Buffer.from(cfgSrc).toString('base64')}`
);
let nodeStore = {};
globalThis.chrome = {
  storage: { local: { get: (k, cb) => cb(nodeStore), set: (o, cb) => { Object.assign(nodeStore, o); if (cb) cb(); } } },
  runtime: { lastError: undefined },
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'],
});

async function scenario(name, useRealConfig) {
  const page = await browser.newPage();
  const events = [];
  page.on('console', (m) => {
    const t = m.text();
    if (!t.includes('[StillWithYou]')) return;
    try { events.push(JSON.parse(t.slice(t.indexOf('{')))); } catch (_) {}
  });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));

  await page.goto(`file://${join(HERE, 'whatsapp-fixture.html').split(String.fromCharCode(92)).join('/')}`);
  await page.evaluate(() => {
    window.__swyStorage = {};
    window.chrome = {
      runtime: { lastError: undefined, sendMessage: (msg, cb) => {
        if (msg && msg.type === 'SWY_CONFIG') { window.__swyConfigBridge(true).then(cb); return; }
        window.__swyBridge(msg.content).then(cb);
      } },
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
  await page.exposeFunction('__swyBridge', async (c) => analyzePreview(API, c));
  await page.exposeFunction('__swyConfigBridge', async () =>
    useRealConfig ? loadConfig({ force: true }) : { source: 'unavailable', config: null, reason: 'stubbed' });
  await page.addScriptTag({ content: read('content.js') });

  /* Let boot + the async config fetch settle, as on the real site. */
  await sleep(2500);

  await page.focus('#fixture-compose');
  await page.type('#fixture-compose', 'you are a disgrace', { delay: 60 });
  await sleep(3000);

  const captured = events.filter((e) => e.event === 'draft_captured');
  const results = events.filter((e) => e.event === 'analysis_result');
  const banners = events.filter((e) => e.event === 'banner_shown');

  console.log(`\n${'='.repeat(88)}\n${name}\n${'='.repeat(88)}`);
  for (const e of events) {
    const extra = Object.entries(e).filter(([k]) => !['ts', 'event'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : v}`).join(' ');
    console.log(`   ${e.event.padEnd(24)} ${extra.slice(0, 90)}`);
  }
  console.log(`   --> draft_captured: ${captured.length}   analysis_result: ${results.length}   banner_shown: ${banners.length}`);
  if (errs.length) console.log(`   --> PAGE ERRORS: ${errs.join('; ')}`);
  await page.close();
  return { captured: captured.length, results: results.length, banners: banners.length };
}

const withCfg = await scenario('SCENARIO A — real remote config (as on web.whatsapp.com)', true);
nodeStore = {};
const noCfg = await scenario('SCENARIO B — config stubbed unavailable (what the 69-check harness does)', false);

console.log(`\n${'='.repeat(88)}\nVERDICT\n${'='.repeat(88)}`);
console.log(`  with real remote config : draft_captured=${withCfg.captured} analysis=${withCfg.results} banner=${withCfg.banners}`);
console.log(`  with config stubbed off : draft_captured=${noCfg.captured} analysis=${noCfg.results} banner=${noCfg.banners}`);
console.log(withCfg.captured === 0 && noCfg.captured > 0
  ? '\n  REPRODUCED: capture dies only when the remote-config path runs.'
  : withCfg.captured > 0 && noCfg.captured > 0
    ? '\n  NOT reproduced here: capture works in both. Cause is elsewhere.'
    : '\n  Inconclusive / broken in both - see logs above.');

await browser.close();
