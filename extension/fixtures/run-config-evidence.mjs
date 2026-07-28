/* Evidence harness for the remote selector config (Steps 3, 4 and 5).
 *
 *   node run-config-evidence.mjs
 *
 * WHAT IS REAL: selectors.js, remote_config.js, health_check.js and content.js are
 * loaded from source, unmodified, into headless Chrome. `config_source.js` — the fetch,
 * validate and cache logic — is imported and executed in Node, which is architecturally
 * faithful: the real service worker also runs it outside the page.
 *
 * WHAT IS SIMULATED: the config is served by a local HTTP server rather than
 * raw.githubusercontent.com, and `chrome.storage.local` is an object. Serving locally is
 * what makes Step 5 testable at all — it lets a config edit be made and re-fetched
 * within one run, which against GitHub would mean a commit, a push and a CDN wait.
 *
 * NOT COVERED: that raw.githubusercontent.com is reachable, and that GitHub's ~5 minute
 * CDN cache behaves as documented. Those need the file actually pushed, and are the
 * real-site half of Step 5.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..');
const REPO = join(EXT, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8123;

const read = (name) => readFileSync(join(EXT, name), 'utf8');

const results = [];
const check = (label, passed, detail = '') => {
  results.push({ label, passed });
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const header = (t) => console.log(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The config the local server is currently serving. Step 5 mutates this mid-run, which
 * is the whole point: a config push with no code change. */
const SEED = JSON.parse(readFileSync(join(REPO, 'extension-config', 'selectors.json'), 'utf8'));
let served = JSON.parse(JSON.stringify(SEED));
let serveMode = 'ok'; /* 'ok' | 'offline' | 'garbage' */

const server = createServer((_req, res) => {
  if (serveMode === 'offline') {
    res.destroy(); /* Connection refused/reset — the offline case. */
    return;
  }
  if (serveMode === 'garbage') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ targets: { composeBox: { selectors: [] } } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(served));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/* config_source.js with its GitHub URL pointed at the local server. Everything else —
 * the timeout, the validation, the cache read/write, the fallback ordering — is the
 * shipping code, untouched. */
const configSourceSrc = read('config_source.js').replace(
  /const CONFIG_URL =\s*'[^']*';/,
  `const CONFIG_URL = 'http://127.0.0.1:${PORT}/selectors.json';`,
);
const modUrl = `data:text/javascript;base64,${Buffer.from(configSourceSrc).toString('base64')}`;
const { loadConfig, validateConfig } = await import(modUrl);

/* A stand-in for chrome.storage.local on the Node side, shared with the page so the
 * cache genuinely persists between "sessions" the way real storage does. */
let nodeStorage = {};
globalThis.chrome = {
  storage: {
    local: {
      get: (keys, cb) => cb(nodeStorage),
      set: (obj, cb) => {
        Object.assign(nodeStorage, obj);
        if (cb) cb();
      },
    },
  },
  runtime: { lastError: undefined },
};

async function makePage(browser, { storage = {} } = {}) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => {
    const t = m.text();
    logs.push(t);
    if (t.includes('config_source') || t.includes('selector_order_learned') || t.includes('config_applied')) {
      console.log(`      ${t}`);
    }
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));

  await page.goto(`file://${join(HERE, 'whatsapp-fixture.html').replace(/\\/g, '/')}`);
  await page.evaluate((initial) => {
    window.__swyStorage = initial;
    window.chrome = {
      runtime: {
        lastError: undefined,
        sendMessage: (msg, cb) => {
          if (msg && msg.type === 'SWY_CONFIG') {
            window.__swyConfigBridge(Boolean(msg.force)).then(cb);
            return;
          }
          cb({ ok: false, reason: 'unreachable' });
        },
      },
      storage: {
        local: {
          get: (k, cb) => cb(window.__swyStorage),
          set: (o, cb) => {
            Object.assign(window.__swyStorage, o);
            if (cb) cb();
          },
        },
      },
    };
  }, storage);

  await page.addStyleTag({ content: read('banner.css') });
  await page.addScriptTag({ content: read('config.js') });
  await page.addScriptTag({ content: read('selectors.js') });
  await page.addScriptTag({ content: read('remote_config.js') });
  await page.addScriptTag({ content: read('health_check.js') });
  await page.addScriptTag({ content: read('banner.js') });

  await page.exposeFunction('__swyConfigBridge', async (force) => loadConfig({ force }));

  return { page, logs, pageErrors };
}

const sourceOf = (logs) => {
  const line = [...logs].reverse().find((l) => l.includes('"event":"config_source"'));
  if (!line) return null;
  return JSON.parse(line.slice(line.indexOf('{'))).source;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});

try {
  /* ================================================================= */
  header('STEP 2 — validation rejects malformed config before it is cached');

  check('valid seed config passes', validateConfig(SEED) === null, String(validateConfig(SEED)));
  check('rejects non-object', validateConfig(null) === 'not_an_object');
  check('rejects missing targets', validateConfig({}) === 'missing_targets');
  check(
    'rejects empty selector array',
    validateConfig({ targets: { composeBox: { selectors: [] }, sendButton: { selectors: ['x'] } }, conversationOpen: ['#main'] }) ===
      'empty_selectors:composeBox',
  );
  check(
    'rejects missing conversationOpen — would cause false outage reports',
    validateConfig({
      targets: { composeBox: { selectors: ['a'] }, sendButton: { selectors: ['b'] } },
    }) === 'missing_conversation_open',
  );

  /* ================================================================= */
  header('STEP 3a — remote: network up, config fetched fresh');

  nodeStorage = {};
  serveMode = 'ok';
  {
    const { page, logs, pageErrors } = await makePage(browser);
    await page.addScriptTag({ content: read('content.js') });
    await sleep(900);

    check('config_source logged `remote`', sourceOf(logs) === 'remote', String(sourceOf(logs)));
    check('extension reports source = remote', (await page.evaluate(() => window.SWY.selectors.source)) === 'remote');
    check('compose box still resolves under remote config', (await page.evaluate(() => Boolean(window.SWY.selectors.composeBox()))));
    check(
      'config written to chrome.storage.local cache',
      Boolean(nodeStorage.remote_selector_config && nodeStorage.remote_selector_config.config),
    );
    check(
      'cache entry carries a timestamp',
      Boolean(nodeStorage.remote_selector_config && nodeStorage.remote_selector_config.cachedAt),
      nodeStorage.remote_selector_config && nodeStorage.remote_selector_config.cachedAt,
    );
    check('no uncaught error', pageErrors.length === 0, pageErrors.join('; '));
    await page.close();
  }

  /* ================================================================= */
  header('STEP 3b — cache: network blocked, last-known-good used');

  serveMode = 'offline';
  {
    const cachedBefore = JSON.parse(JSON.stringify(nodeStorage));
    const { page, logs, pageErrors } = await makePage(browser, { storage: cachedBefore });
    await page.addScriptTag({ content: read('content.js') });
    await sleep(900);

    check('config_source logged `cache`', sourceOf(logs) === 'cache', String(sourceOf(logs)));
    check('extension reports source = cache', (await page.evaluate(() => window.SWY.selectors.source)) === 'cache');
    check('compose box still resolves from cached config', (await page.evaluate(() => Boolean(window.SWY.selectors.composeBox()))));
    check('no health indicator — a config outage is not a DOM outage', (await page.$('#swy-health-indicator')) === null);
    check('no uncaught error', pageErrors.length === 0, pageErrors.join('; '));
    await page.close();
  }

  /* ================================================================= */
  header('STEP 3c — hardcoded: network blocked AND cache cleared');

  nodeStorage = {};
  serveMode = 'offline';
  {
    const { page, logs, pageErrors } = await makePage(browser, { storage: {} });
    await page.addScriptTag({ content: read('content.js') });
    await sleep(900);

    check('config_source logged `hardcoded`', sourceOf(logs) === 'hardcoded', String(sourceOf(logs)));
    check('extension reports source = hardcoded', (await page.evaluate(() => window.SWY.selectors.source)) === 'hardcoded');
    check('compose box STILL resolves from the frozen snapshot', (await page.evaluate(() => Boolean(window.SWY.selectors.composeBox()))));
    check('no uncaught error', pageErrors.length === 0, pageErrors.join('; '));
    await page.close();
  }

  /* ================================================================= */
  header('STEP 3d — a reachable but INVALID config must not poison the cache');

  nodeStorage = {};
  serveMode = 'ok';
  {
    /* Seed a good cache first. */
    const { page: p1 } = await makePage(browser);
    await p1.addScriptTag({ content: read('content.js') });
    await sleep(700);
    await p1.close();
    const goodCache = JSON.parse(JSON.stringify(nodeStorage));

    serveMode = 'garbage';
    const { page, logs, pageErrors } = await makePage(browser, { storage: goodCache });
    await page.addScriptTag({ content: read('content.js') });
    await sleep(900);

    check('falls back to cache, not to the garbage', sourceOf(logs) === 'cache', String(sourceOf(logs)));
    check(
      'good cache entry survived the bad push',
      JSON.stringify(nodeStorage.remote_selector_config.config) ===
        JSON.stringify(goodCache.remote_selector_config.config),
    );
    check('no uncaught error', pageErrors.length === 0, pageErrors.join('; '));
    await page.close();
  }

  /* ================================================================= */
  header('STEP 4 — self-tuning selector order');

  nodeStorage = {};
  serveMode = 'ok';
  /* Break the FIRST selector only, so index 1 becomes the only one that matches. This is
   * what a partial WhatsApp change looks like: the specific attribute moved, the
   * structural fallback still works. */
  served = JSON.parse(JSON.stringify(SEED));
  served.targets.composeBox.selectors[0] = 'div.no-such-element-first-rung';
  served.version = 2;

  {
    const { page, logs, pageErrors } = await makePage(browser);
    await page.addScriptTag({ content: read('content.js') });
    await sleep(900);

    /* Clear the learned hint first. content.js has already booted and resolved, so the
     * hint is set by the time we get here — measuring now would show the tuned path and
     * miss the untuned one entirely. Clearing gives a true "before". */
    await page.evaluate(() => window.SWY.selectors.forgetHints());

    const first = await page.evaluate(() => window.SWY.selectors.resolve('composeBox'));
    console.log(`\n   1st resolution (hint cleared) attempted ${first.attempted.length}: matched index ${first.matchedIndex}`);

    const hints = await page.evaluate(() => window.SWY.selectors.lastSuccessHints());
    const order = await page.evaluate(() => window.SWY.selectors.attemptOrder('composeBox', 4));
    const second = await page.evaluate(() => window.SWY.selectors.resolve('composeBox'));
    console.log(`   learned hint: ${JSON.stringify(hints)}`);
    console.log(`   next attempt order: [${order}]  (config order is [0,1,2,3])`);
    console.log(`   2nd resolution attempted ${second.attempted.length}: matched index ${second.matchedIndex}`);

    check('first resolution had to try the dead rung first', first.attempted.length === 2);
    check('learned that index 1 works', hints.composeBox === 1, JSON.stringify(hints));
    check('next attempt order puts 1 first', order[0] === 1, `[${order}]`);
    check('second resolution succeeds on its FIRST attempt', second.attempted.length === 1);
    check('still reports the true matched index', second.matchedIndex === 1, String(second.matchedIndex));
    check('hint persisted to storage', (await page.evaluate(() => window.__swyStorage.selector_last_success)) !== undefined);
    check('selector_order_learned was logged', logs.some((l) => l.includes('selector_order_learned')));
    check('no uncaught error', pageErrors.length === 0, pageErrors.join('; '));
    await page.close();
  }

  header('STEP 4b — healthy config: self-tuning must change nothing');

  served = JSON.parse(JSON.stringify(SEED));
  nodeStorage = {};
  {
    const { page, pageErrors } = await makePage(browser);
    await page.addScriptTag({ content: read('content.js') });
    await sleep(900);

    const r1 = await page.evaluate(() => window.SWY.selectors.resolve('composeBox'));
    const order = await page.evaluate(() => window.SWY.selectors.attemptOrder('composeBox', 4));
    const r2 = await page.evaluate(() => window.SWY.selectors.resolve('composeBox'));

    check('matches on index 0 as configured', r1.matchedIndex === 0);
    check('attempt order unchanged from config', JSON.stringify(order) === '[0,1,2,3]', `[${order}]`);
    check('one attempt, both times', r1.attempted.length === 1 && r2.attempted.length === 1);
    check('no uncaught error', pageErrors.length === 0, pageErrors.join('; '));
    await page.close();
  }

  /* ================================================================= */
  header('STEP 5 — config-push recovery, no code change');

  nodeStorage = {};
  serveMode = 'ok';

  /* BEFORE: simulate WhatsApp having changed so that EVERY selector in the shipped
   * config is dead. This is the state where the extension is broken and, without remote
   * config, would need a code edit + reload to fix. */
  served = JSON.parse(JSON.stringify(SEED));
  served.targets.composeBox.selectors = [
    'div.whatsapp-changed-everything-1',
    'div.whatsapp-changed-everything-2',
  ];
  served.version = 3;

  let beforeState;
  {
    const { page, logs, pageErrors } = await makePage(browser);
    await page.addScriptTag({ content: read('content.js') });
    await sleep(900);
    beforeState = await page.evaluate(() => window.SWY.health.inspect().state);
    const indicator = (await page.$('#swy-health-indicator')) !== null;
    console.log(`\n   BEFORE  config v${served.version}: health=${beforeState}, indicator=${indicator}`);
    check('extension is broken, as expected', beforeState === 'detached');
    check('indicator shown to the user', indicator === true);
    check('config source is remote — it is running the broken config', sourceOf(logs) === 'remote');
    check('no uncaught error even while broken', pageErrors.length === 0, pageErrors.join('; '));
    await page.close();
  }

  /* THE FIX: edit the JSON only. No extension file is touched, nothing is rebuilt,
   * nothing is reloaded from disk. */
  served.targets.composeBox.selectors = [
    'footer div[contenteditable="true"][data-tab="10"]',
    'div[role="textbox"][contenteditable="true"]',
  ];
  served.version = 4;
  served.note = 'simulated fix: new compose box selector after a WhatsApp change';
  console.log(`\n   >>> edited selectors.json only: v3 -> v4. No extension code changed. <<<`);

  {
    const { page, logs, pageErrors } = await makePage(browser);
    await page.addScriptTag({ content: read('content.js') });
    await sleep(900);
    const afterState = await page.evaluate(() => window.SWY.health.inspect().state);
    const indicator = (await page.$('#swy-health-indicator')) !== null;
    const version = await page.evaluate(() => window.SWY.selectors.version);
    console.log(`   AFTER   config v${version}: health=${afterState}, indicator=${indicator}`);

    check('extension recovered', afterState === 'attached', afterState);
    check('indicator cleared', indicator === false);
    check('running the new config version', version === 4, String(version));
    check('config source still remote', sourceOf(logs) === 'remote');
    check('compose box resolves again', (await page.evaluate(() => Boolean(window.SWY.selectors.composeBox()))));
    check('no uncaught error', pageErrors.length === 0, pageErrors.join('; '));
    await page.close();
  }

  console.log(`\n   Recovery required: 1 JSON edit. Extension code changed: 0 files.`);
} finally {
  await browser.close();
  server.close();
}

const passed = results.filter((r) => r.passed).length;
header(`SUMMARY — ${passed}/${results.length} checks passed`);
results.filter((r) => !r.passed).forEach((r) => console.log(`   FAILED: ${r.label}`));
process.exit(passed === results.length ? 0 : 1);
