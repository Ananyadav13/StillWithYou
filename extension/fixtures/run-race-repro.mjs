/* Send/banner race reproduction — Step 2 (fixture half).
 *
 *   node run-race-repro.mjs [--api http://127.0.0.1:8000]
 *
 * WHAT THIS IS AND IS NOT EVIDENCE OF. Read before quoting any number.
 *
 *   REAL: content.js, banner.js, selectors.js and api.js are the shipping files with the
 *   Step 1 instrumentation. The 1500ms debounce, the message-passing hop, the real HTTP
 *   call to a real backend, and the real banner mount are all exercised. Every timestamp
 *   below is a genuine measurement of the extension's own pipeline.
 *
 *   SIMULATED: the DOM is the fixture, and the "send" is this script clearing the compose
 *   box the way WhatsApp does. The SEND MOMENT is therefore scripted. That pins down when
 *   the extension's timers fire relative to a send, but cannot prove WhatsApp clears its
 *   box the same way. The real-site capture closes that gap.
 *
 * TWO UNKNOWNS ARE BRACKETED RATHER THAN GUESSED:
 *
 *   1. Does clearing the box fire an `input` event? If it does, the pending debounce is
 *      RESTARTED on an empty box. If it does not, the pending debounce still fires on a
 *      box that is empty by then. Both are run.
 *
 *   2. How long after the last keystroke does the user hit send? This is the actual
 *      variable that decides the outcome, so it is swept rather than assumed - which is
 *      also what Step 4 needs to state a risk window from data.
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
const API_BASE = apiArg > -1 ? process.argv[apiArg + 1] : 'http://127.0.0.1:8000';
const read = (n) => readFileSync(join(EXT, n), 'utf8');

const MESSAGE = 'you are a disgrace';   /* the real observed case, 18 chars */
const CHAR_DELAY_MS = 60;               /* brisk fast typing */
const DEBOUNCE_MS = 1500;

/* Step 2 as briefed: 3 identical fast runs. Step 4: the sweep. */
const FAST_SEND_MS = 180;
const SWEEP_MS = [180, 800, 1400, 1600, 2200];

const line = (n) => '='.repeat(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'],
});

/** One reproduction: type the message, wait, send, observe. */
async function attempt({ sendDelayMs, fireInput }) {
  const page = await browser.newPage();
  const events = [];
  page.on('console', (m) => {
    const t = m.text();
    if (!t.includes('[StillWithYou]')) return;
    try {
      const o = JSON.parse(t.slice(t.indexOf('{')));
      /* log() builds {ts, event, ...fields}, so a trace's own `event` overwrites the
       * outer 'trace' label. Identify trace lines by their t_ms field instead. */
      if (typeof o.t_ms === 'number') events.push(o);
    } catch (_) { /* not a trace line */ }
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
          if (msg && msg.type === 'SWY_CONFIG') { cb({ source: 'unavailable', config: null }); return; }
          window.__swyBridge(msg.content).then(cb);
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
  await page.exposeFunction('__swyBridge', async (content) => analyzePreview(API_BASE, content));
  await page.addScriptTag({ content: read('content.js') });
  await sleep(400);

  await page.focus('#fixture-compose');
  await page.type('#fixture-compose', MESSAGE, { delay: CHAR_DELAY_MS });
  await sleep(sendDelayMs);

  /* THE SEND. Clears the compose box as WhatsApp does, which is what the instrumentation
   * watches for. The click is on the fixture's own button; nothing in the extension is
   * bound to it. */
  const bannerAtSend = (await page.$('#swy-nudge-banner')) !== null;
  await page.evaluate((fi) => {
    document.getElementById('fixture-send').click();
    document.getElementById('fixture-compose').innerText = '';
    if (fi) {
      document.getElementById('fixture-compose').dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, fireInput);

  await sleep(6000);  /* well past debounce + request + render */

  const bannerUp = (await page.$('#swy-nudge-banner')) !== null;
  await page.close();

  const t0 = events.length ? events[0].t_ms : 0;
  const at = (name) => {
    const e = events.find((x) => x.event === name);
    return e ? e.t_ms - t0 : null;
  };
  return {
    events, t0, bannerUp, bannerAtSend, pageErrors, sendDelayMs, fireInput,
    input_start: at('input_start'),
    debounce_fired: at('debounce_fired'),
    send_detected: at('send_detected'),
    request: at('analysis_request_sent'),
    response: at('analysis_response_received'),
    banner: at('banner_mounted'),
  };
}

console.log(line(96));
console.log('STEP 2 (fixture half) — "type fast, send immediately"');
console.log(line(96));
console.log(`  message "${MESSAGE}" (${MESSAGE.length} chars) @ ${CHAR_DELAY_MS}ms/char = ~${MESSAGE.length * CHAR_DELAY_MS}ms to type`);
console.log(`  send ${FAST_SEND_MS}ms after last keystroke   DEBOUNCE_MS=${DEBOUNCE_MS}   backend=${API_BASE}`);

for (const variant of [{ name: 'clear fires input', fireInput: true },
                       { name: 'clear is silent', fireInput: false }]) {
  console.log(`\n${line(96)}\nVARIANT: send ${variant.name}\n${line(96)}`);
  for (let run = 1; run <= 3; run += 1) {
    const r = await attempt({ sendDelayMs: FAST_SEND_MS, fireInput: variant.fireInput });
    console.log(`\n  --- run ${run} ---`);
    for (const e of r.events) {
      const extra = Object.entries(e)
        .filter(([k]) => !['event', 't_ms', 't_rel_ms', 'msg', 'chars', 'ts', 'level'].includes(k))
        .map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`    +${String(e.t_ms - r.t0).padStart(5)}ms  ${e.event.padEnd(26)} ${extra}`);
    }
    const { send_detected: s, debounce_fired: d, banner: b } = r;
    console.log(`    -> send vs debounce : ${s === null || d === null
      ? (d === null ? 'DEBOUNCE NEVER FIRED' : 'n/a')
      : s < d ? `SEND FIRST by ${d - s}ms` : `DEBOUNCE FIRST by ${s - d}ms`}`);
    console.log(`    -> send vs banner   : ${b === null ? 'BANNER NEVER MOUNTED'
      : s === null ? 'n/a' : s < b ? `SEND FIRST by ${b - s}ms` : `BANNER FIRST by ${s - b}ms`}`);
    console.log(`    -> BANNER PRESENT AT MOMENT OF SEND : ${r.bannerAtSend}`);
    console.log(`    -> banner on screen after : ${r.bannerUp}`);
    if (r.pageErrors.length) console.log(`    -> PAGE ERRORS: ${r.pageErrors.join('; ')}`);
  }
}

/* --------------------------------------------------------------- Step 4 sweep */
console.log(`\n${line(96)}\nSTEP 4 — send-delay sweep (where does behaviour change?)\n${line(96)}`);
console.log('  send delay = ms between last keystroke and hitting send\n');
console.log('  variant             delay   debounce   send    banner   send->banner   analysed?');
for (const variant of [{ name: 'clear fires input', fireInput: true },
                       { name: 'clear is silent', fireInput: false }]) {
  for (const delay of SWEEP_MS) {
    const r = await attempt({ sendDelayMs: delay, fireInput: variant.fireInput });
    const gap = r.send_detected !== null && r.banner !== null ? r.banner - r.send_detected : null;
    console.log(
      `  ${variant.name.padEnd(19)} ${String(delay).padStart(5)}   ` +
      `${String(r.debounce_fired ?? '-').padStart(8)}   ${String(r.send_detected ?? '-').padStart(5)}   ` +
      `${String(r.banner ?? '-').padStart(6)}   ${String(gap ?? '-').padStart(12)}   ${r.request !== null}`,
    );
  }
}

await browser.close();
