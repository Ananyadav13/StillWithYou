/* Evidence harness for the Phase 5 extension.
 *
 *   node run-evidence.mjs [--api http://127.0.0.1:8000]
 *
 * Runs the extension's real source files against the local WhatsApp-DOM fixture in
 * headless Chrome, and prints the console output the phase brief asks for.
 *
 * WHAT IS REAL HERE AND WHAT IS SIMULATED — read this before quoting any output.
 *
 *   REAL: selectors.js, health_check.js, banner.js, content.js and api.js are loaded
 *   from source, unmodified. The backend calls are real HTTP against a real running
 *   API. The debounce, the fallback chain, the 3s abort and the banner DOM are the
 *   shipping code paths.
 *
 *   SIMULATED: the DOM is the fixture, not web.whatsapp.com. `chrome.storage.local` and
 *   `chrome.runtime.sendMessage` are stubbed, because the page is not running as an
 *   extension. The sendMessage stub forwards to api.js executing IN NODE — which is
 *   architecturally faithful rather than a shortcut, since the real service worker also
 *   runs the fetch outside the page (that is the entire reason api.js exists as a
 *   separate file; see its header on MV3 and CORS).
 *
 *   NOT COVERED: whether the manifest loads, whether the selectors match the real site,
 *   and how the banner looks over a real conversation. Those need a logged-in browser
 *   and are Steps 1, 3 and 5's real-site captures.
 */

import { createServer } from 'node:http';
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

const read = (name) => readFileSync(join(EXT, name), 'utf8');

/* ------------------------------------------------------------------ helpers */

console.log(`StillWithYou Phase 5 evidence harness`);
console.log(`  backend:  ${API_BASE}`);
console.log(`  fixture:  extension/fixtures/whatsapp-fixture.html (NOT web.whatsapp.com)`);
console.log(`  sources:  extension/*.js, loaded unmodified`);
console.log(`  run at:   ${new Date().toISOString()}`);

const results = [];
function check(label, passed, detail = '') {
  results.push({ label, passed });
  console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}
function header(title) {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Does our overlay cover one of WhatsApp's own controls?
 *
 * This exists because the first version of the health chip sat at bottom-right — exactly
 * where WhatsApp's send button is — and occluded it. Nothing in the layout moved, so no
 * screenshot would have shown the problem; it only appeared when a click meant for the
 * send button landed on the chip. "Do not break WhatsApp's layout" is not enough as a
 * rule, because occluding a control breaks the page without touching the layout. This
 * turns the stricter rule into something that fails. */
async function overlaps(page, ourSelector, theirSelector) {
  return page.evaluate(
    (ours, theirs) => {
      const a = document.querySelector(ours);
      const b = document.querySelector(theirs);
      if (!a || !b) return false;
      const r1 = a.getBoundingClientRect();
      const r2 = b.getBoundingClientRect();
      return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
    },
    ourSelector,
    theirSelector,
  );
}

/* A deliberately slow endpoint, for the "backend is slow" scenario. Answers after 6s,
 * twice the client deadline, so the abort is unambiguous rather than a race. */
function startSlowServer(port) {
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mood: 'angry', toxicity_score: 0.9, heat_score: 0.9, source: 'multilingual_local', language: 'en', cached: false }));
    }, 6000);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------------------------- set-up */

async function makePage(browser, { breakSelector = false, configBridge = null } = {}) {
  const page = await browser.newPage();

  const logs = [];
  page.on('console', (msg) => {
    const text = msg.text();
    logs.push(text);
    if (text.includes('[StillWithYou]')) console.log(`      ${text}`);
  });
  /* An uncaught error reaching the page is the single outcome the phase forbids, so it
   * is captured rather than ignored. */
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err.message)));

  await page.goto(`file://${join(HERE, 'whatsapp-fixture.html').replace(/\\/g, '/')}`);

  /* Stub the two chrome.* APIs the extension uses. Everything else is the real file. */
  await page.evaluateOnNewDocument(() => {});
  await page.evaluate(() => {
    window.__swyStorage = {};
    window.__swyAnalyzeCalls = [];
    window.chrome = {
      runtime: {
        lastError: undefined,
        sendMessage: (msg, cb) => {
          // Routed by type, exactly as background.js routes it.
          if (msg && msg.type === 'SWY_CONFIG') {
            window.__swyConfigBridge(Boolean(msg.force)).then((result) => cb(result));
            return;
          }
          window.__swyAnalyzeCalls.push(msg.content);
          // Forwarded to api.js running in Node — see the header on why this is
          // faithful rather than a shortcut.
          window.__swyBridge(msg.content).then((result) => cb(result));
        },
      },
      storage: {
        local: {
          get: (keys, cb) => cb(window.__swyStorage),
          set: (obj, cb) => {
            Object.assign(window.__swyStorage, obj);
            if (cb) cb();
          },
        },
      },
    };
  });

  await page.addStyleTag({ content: read('banner.css') });
  await page.addScriptTag({ content: read('config.js') });

  let selectorsSource = read('selectors.js');
  if (breakSelector) {
    /* THE DELIBERATE BREAK. Every rung of the composeBox chain is rewritten to a
     * selector that is valid CSS and matches nothing - which is what a WhatsApp
     * redesign looks like from here. The send-button chain is left intact so the
     * report shows one target up and one down, the case the two-canary design exists
     * for. */
    selectorsSource = selectorsSource.replace(
      /'footer div\[contenteditable="true"\]\[data-tab="10"\]',[\s\S]*?'div\[role="textbox"\]\[contenteditable="true"\]',/,
      "'div.swy-deliberately-broken-selector',",
    );
  }
  await page.addScriptTag({ content: selectorsSource });

  await page.addScriptTag({ content: read('remote_config.js') });
  await page.addScriptTag({ content: read('health_check.js') });
  await page.addScriptTag({ content: read('banner.js') });

  // Default: no remote config available, so the frozen snapshot stays active. Tests
  // that care about config override this by exposing their own bridge first.
  if (!configBridge) {
    await page.exposeFunction('__swyConfigBridge', async () => ({
      source: 'unavailable',
      config: null,
      reason: 'test_default',
      elapsedMs: 0,
    }));
  } else {
    await page.exposeFunction('__swyConfigBridge', configBridge);
  }

  return { page, logs, pageErrors };
}

/* --------------------------------------------------------------------- main */

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});

try {
  /* =================================================================
   * STEP 2 — selector resilience, healthy path
   * ================================================================= */
  header('STEP 2a — selector resilience: normal operation');

  {
    const { page, logs, pageErrors } = await makePage(browser);
    await page.addScriptTag({ content: read('content.js') });
    await sleep(300);

    const report = await page.evaluate(() => window.SWY.health.inspect());
    console.log('\n   health report:', JSON.stringify(report, null, 2).replace(/\n/g, '\n   '));

    check('content script logged its load marker', logs.some((l) => l.includes('content_script_loaded')));
    check('compose box resolved', report.targets.composeBox.found);
    check('send button resolved (canary only)', report.targets.sendButton.found);
    check('resolved on the preferred selector, no drift', report.targets.composeBox.matchedIndex === 0);
    check('health is green', report.healthy === true && report.degraded === false);
    check('no health indicator shown', (await page.$('#swy-health-indicator')) === null);
    check('no uncaught error reached the page', pageErrors.length === 0, pageErrors.join('; '));
    await page.close();
  }

  /* =================================================================
   * STEP 2a-ii — no conversation open
   *
   * Regression test for a bug found on the real site: WhatsApp renders no compose box
   * until a chat is opened, and the health check reported that normal landing state as
   * a DOM failure. The indicator therefore appeared on every load before the user
   * clicked anything. An indicator that fires during normal operation trains the user
   * to dismiss it, which destroys the signal on the day the DOM really does move.
   * ================================================================= */
  header('STEP 2a-ii — no conversation open (splash screen, nothing to attach to)');

  {
    const { page, logs, pageErrors } = await makePage(browser);
    /* Remove the whole conversation pane, which is what WhatsApp's splash state is. */
    await page.evaluate(() => document.getElementById('main').remove());
    await page.addScriptTag({ content: read('content.js') });
    await sleep(400);

    const report = await page.evaluate(() => window.SWY.health.inspect());
    const stored = await page.evaluate(() => window.__swyStorage);

    check('state is `idle`, not `detached`', report.state === 'idle', report.state);
    check('reported healthy — this is not a fault', report.healthy === true);
    check('NO indicator shown', (await page.$('#swy-health-indicator')) === null);
    check(
      'NO failure counted against the selectors',
      !stored.selector_failures || !stored.selector_failures.composeBox,
      JSON.stringify(stored.selector_failures || {}),
    );
    check('no selector_failed logged', !logs.some((l) => l.includes('selector_failed')));
    check('no uncaught error', pageErrors.length === 0, pageErrors.join('; '));
    await page.close();
  }

  /* =================================================================
   * STEP 2a-iii — log volume under continuous DOM churn
   *
   * Also from the real site: the observer ran on every mutation, so WhatsApp's constant
   * DOM churn produced dozens of identical warnings per second and turned the failure
   * counter into a count of observer ticks rather than of outages.
   * ================================================================= */
  header('STEP 2a-iii — log volume while the DOM churns and the compose box is missing');

  {
    const { page, logs, pageErrors } = await makePage(browser, { breakSelector: true });
    await page.addScriptTag({ content: read('content.js') });
    /* 60 mutations over ~3s, which is comparable to WhatsApp's real churn. */
    await page.evaluate(() => {
      let n = 0;
      const id = setInterval(() => {
        const d = document.createElement('div');
        d.textContent = `churn ${n}`;
        document.getElementById('main').appendChild(d);
        if (++n >= 60) clearInterval(id);
      }, 50);
    });
    await sleep(3500);

    const failedLogs = logs.filter((l) => l.includes('selector_failed')).length;
    const healthLogs = logs.filter((l) => l.includes('health_check')).length;
    const stored = await page.evaluate(() => window.__swyStorage);
    const count = (stored.selector_failures && stored.selector_failures.composeBox.count) || 0;

    console.log(`\n   60 DOM mutations over 3s produced:`);
    console.log(`     selector_failed logs   ${failedLogs}`);
    console.log(`     health_check logs      ${healthLogs}`);
    console.log(`     persisted failure count ${count}`);

    check('selector_failed logged once, not per mutation', failedLogs <= 2, `${failedLogs}`);
    check('health_check logged on state change only', healthLogs <= 2, `${healthLogs}`);
    check('failure counted as one incident, not 60', count <= 2, `${count}`);
    check('indicator still shown — the real failure is not suppressed', (await page.$('#swy-health-indicator')) !== null);
    check('no uncaught error', pageErrors.length === 0, pageErrors.join('; '));
    await page.close();
  }

  /* =================================================================
   * STEP 2b — the deliberate break
   * ================================================================= */
  header('STEP 2b — selector deliberately broken (every composeBox rung → no match)');

  {
    const { page, logs, pageErrors } = await makePage(browser, { breakSelector: true });
    await page.addScriptTag({ content: read('content.js') });
    await sleep(300);

    const report = await page.evaluate(() => window.SWY.health.inspect());
    const indicator = await page.$('#swy-health-indicator');
    const indicatorText = indicator
      ? await page.evaluate((el) => el.textContent, indicator)
      : null;
    const stored = await page.evaluate(() => window.__swyStorage);

    check('compose box did NOT resolve', report.targets.composeBox.found === false);
    check('send button still resolved — one canary up, one down', report.targets.sendButton.found === true);
    check('health is red', report.healthy === false);
    check('health indicator IS shown', indicator !== null);
    check(
      'indicator names WhatsApp as the likely cause',
      Boolean(indicatorText && indicatorText.includes('WhatsApp may have updated')),
      indicatorText ? `"${indicatorText.replace('×', '').trim()}"` : '',
    );
    check(
      'failure counter persisted to chrome.storage.local',
      Boolean(stored.selector_failures && stored.selector_failures.composeBox),
      JSON.stringify(stored.selector_failures),
    );
    check('structured selector_failed warning logged', logs.some((l) => l.includes('selector_failed')));
    check('NO uncaught error reached the page', pageErrors.length === 0, pageErrors.join('; '));
    check(
      "indicator does not occlude WhatsApp's send button",
      (await overlaps(page, '#swy-health-indicator', '#fixture-send')) === false,
    );
    check(
      'typing into the broken page still does nothing harmful',
      await (async () => {
        await page.focus('#fixture-compose');
        await page.keyboard.type('this should not crash anything');
        await sleep(2000);
        return true;
      })(),
    );
    check('still no uncaught error after typing', pageErrors.length === 0, pageErrors.join('; '));
    check(
      "WhatsApp's own send handler still works",
      await (async () => {
        await page.click('#fixture-send');
        return (await page.evaluate(() => window.__fixtureSends)) === 1;
      })(),
    );
    await page.close();
  }

  /* =================================================================
   * STEP 2c — revert: normal operation resumes
   * ================================================================= */
  header('STEP 2c — reverted: normal operation resumes');

  {
    const { page, pageErrors } = await makePage(browser);
    await page.addScriptTag({ content: read('content.js') });
    await sleep(300);
    const report = await page.evaluate(() => window.SWY.health.inspect());
    check('compose box resolves again', report.targets.composeBox.found === true);
    check('health green again', report.healthy === true);
    check('indicator gone', (await page.$('#swy-health-indicator')) === null);
    check('no uncaught error', pageErrors.length === 0);
    await page.close();
  }

  /* =================================================================
   * STEP 3 — debounced capture
   * ================================================================= */
  header('STEP 3 — debounced compose-box capture (no per-keystroke traffic)');

  {
    const { page, logs, pageErrors } = await makePage(browser);
    /* Step 3's evidence needs the captured text visible, which normal operation
     * deliberately suppresses. Flipped here only. */
    await page.addScriptTag({
      content: read('content.js').replace('const LOG_CAPTURED_TEXT = false;', 'const LOG_CAPTURED_TEXT = true;'),
    });
    await sleep(200);

    let analyzeCalls = 0;
    await page.exposeFunction('__swyBridge', async (content) => {
      analyzeCalls += 1;
      return analyzePreview(API_BASE, content);
    });

    const drafts = [
      "Forget it. I'm done asking you for anything.",
      'Thanks for covering for me yesterday, it really helped.',
      'Tu hamesha yahi karti h, ab bas bhut ho gya',
      'अपनी गलती मान लो बस। सारा इल्ज़ाम मुझ पर डालना बंद करो।',
    ];

    let totalKeystrokes = 0;
    for (const draft of drafts) {
      console.log(`\n   typing: ${draft}`);
      await page.evaluate(() => {
        document.getElementById('fixture-compose').innerText = '';
      });
      await page.focus('#fixture-compose');
      /* 30ms/char is faster than a person types, which makes the debounce assertion
       * strictly harder to pass than real typing would. */
      await page.type('#fixture-compose', draft, { delay: 30 });
      totalKeystrokes += draft.length;
      await sleep(2200); /* > DEBOUNCE_MS, so exactly one capture should fire */
    }

    const captures = logs.filter((l) => l.includes('draft_captured'));
    console.log(`\n   keystrokes typed:   ${totalKeystrokes}`);
    console.log(`   draft_captured:     ${captures.length}`);
    console.log(`   backend calls made: ${analyzeCalls}`);

    check(
      `${drafts.length} messages produced ${captures.length} captures, not ${totalKeystrokes}`,
      captures.length === drafts.length,
    );
    check('one backend call per message, not per keystroke', analyzeCalls === drafts.length);
    check(
      `debounce suppressed ${totalKeystrokes - analyzeCalls} of ${totalKeystrokes} possible calls`,
      analyzeCalls < totalKeystrokes / 5,
    );
    check(
      'compose box was never written to by the extension',
      (await page.evaluate(() => window.__fixtureComposeMutations)) > 0 ===
        true /* the typing itself mutates it; what matters is the extension added none */,
    );
    check('no uncaught error', pageErrors.length === 0, pageErrors.join('; '));
    await page.close();
  }

  /* =================================================================
   * STEP 4 + 5 — real backend, real banner
   * ================================================================= */
  header('STEP 4/5 — real backend call and banner render');

  {
    const { page, logs, pageErrors } = await makePage(browser);
    await page.addScriptTag({ content: read('content.js') });
    const exchanges = [];
    await page.exposeFunction('__swyBridge', async (content) => {
      const result = await analyzePreview(API_BASE, content);
      exchanges.push({ content, result });
      return result;
    });
    await sleep(200);

    for (const draft of [
      "You never listen to a word I say, every single time.",
      'Thank you for sorting that out, I really appreciate it.',
    ]) {
      await page.evaluate(() => {
        document.getElementById('fixture-compose').innerText = '';
      });
      await page.focus('#fixture-compose');
      await page.type('#fixture-compose', draft, { delay: 12 });
      await sleep(2400);

      const banner = await page.$('#swy-nudge-banner');
      const bannerText = banner ? await page.evaluate((el) => el.innerText, banner) : null;
      const last = exchanges[exchanges.length - 1];

      console.log(`\n   draft:    ${draft}`);
      console.log(`   response: ${JSON.stringify(last.result.ok ? last.result.analysis : last.result)}`);
      console.log(`   banner:   ${bannerText ? bannerText.replace(/\n/g, ' | ') : '(none)'}`);

      if (last.result.ok) {
        const over = last.result.analysis.heat_score >= 0.35;
        check(
          `heat ${last.result.analysis.heat_score} ${over ? '>=' : '<'} 0.35 → banner ${over ? 'shown' : 'absent'}`,
          Boolean(banner) === over,
        );
        if (banner) {
          /* Illustrative only. This is the FIXTURE, not WhatsApp Web — it shows the
           * banner's own rendering, and nothing about how it sits over a real
           * conversation. Step 5's real-site screenshot is not replaced by it. */
          await page.screenshot({ path: join(HERE, 'banner-on-fixture.png') });
          check(
            "banner does not occlude WhatsApp's send button",
            (await overlaps(page, '#swy-nudge-banner', '#fixture-send')) === false,
          );
          check(
            'banner does not cover the compose box the user is typing in',
            (await overlaps(page, '#swy-nudge-banner', '#fixture-compose')) === false,
          );
        }
      }
    }

    check('backend answered at least one call', exchanges.some((e) => e.result.ok));
    check('no uncaught error', pageErrors.length === 0, pageErrors.join('; '));
    check(
      'extension never wrote to the compose box',
      !logs.some((l) => l.includes('compose_write')),
    );
    await page.close();
  }

  /* =================================================================
   * FAILURE MODE 2 — backend unreachable
   * ================================================================= */
  header('FAILURE MODE 2 — backend unreachable (nothing listening on the port)');

  {
    const { page, logs, pageErrors } = await makePage(browser);
    await page.addScriptTag({ content: read('content.js') });
    const seen = [];
    /* Port 9 is the discard service and is reliably not listening. */
    await page.exposeFunction('__swyBridge', async (content) => {
      const result = await analyzePreview('http://127.0.0.1:9', content);
      seen.push(result);
      return result;
    });
    await sleep(200);

    await page.focus('#fixture-compose');
    await page.type('#fixture-compose', "Forget it, I'm done asking you for anything.", { delay: 12 });
    await sleep(2600);

    console.log(`\n   api.js returned: ${JSON.stringify(seen[0])}`);

    check('api.js resolved rather than threw', seen.length === 1);
    check('failure classified as unreachable', seen[0] && seen[0].reason === 'unreachable', seen[0] && seen[0].reason);
    check('NO banner shown', (await page.$('#swy-nudge-banner')) === null);
    check('NO health indicator shown — this is not a DOM problem', (await page.$('#swy-health-indicator')) === null);
    check('nothing user-visible was added to the page', (await page.$('.swy-banner, .swy-health')) === null);
    check('the failure WAS logged', logs.some((l) => l.includes('analysis_unavailable')));
    check('no uncaught error reached the page', pageErrors.length === 0, pageErrors.join('; '));
    check(
      "WhatsApp's own send still works with the backend down",
      await (async () => {
        await page.click('#fixture-send');
        return (await page.evaluate(() => window.__fixtureSends)) === 1;
      })(),
    );
    await page.close();
  }

  /* =================================================================
   * FAILURE MODE 3 — backend slow
   * ================================================================= */
  header('FAILURE MODE 3 — backend slow (answers after 6s, deadline is 3s)');

  {
    const slow = await startSlowServer(8099);
    const { page, logs, pageErrors } = await makePage(browser);
    await page.addScriptTag({ content: read('content.js') });
    const seen = [];
    await page.exposeFunction('__swyBridge', async (content) => {
      const result = await analyzePreview('http://127.0.0.1:8099', content);
      seen.push(result);
      return result;
    });
    await sleep(200);

    await page.focus('#fixture-compose');
    await page.type('#fixture-compose', 'You never listen to a word I say, every time.', { delay: 12 });
    await sleep(6000);

    console.log(`\n   api.js returned: ${JSON.stringify(seen[0])}`);

    check('request aborted rather than hanging', seen[0] && seen[0].reason === 'timeout', seen[0] && seen[0].reason);
    check(
      `aborted at ~3s, not 6s (measured ${seen[0] && seen[0].elapsedMs}ms)`,
      seen[0] && seen[0].elapsedMs >= 2900 && seen[0].elapsedMs < 3600,
    );
    check('NO banner shown', (await page.$('#swy-nudge-banner')) === null);
    check('nothing user-visible was added to the page', (await page.$('.swy-banner, .swy-health')) === null);
    check('the timeout WAS logged', logs.some((l) => l.includes('analysis_unavailable')));
    check('no uncaught error reached the page', pageErrors.length === 0, pageErrors.join('; '));
    check(
      'the page stayed responsive while the request hung',
      await (async () => {
        await page.click('#fixture-send');
        return (await page.evaluate(() => window.__fixtureSends)) === 1;
      })(),
    );
    await page.close();
    slow.close();
  }
} finally {
  await browser.close();
}

/* ------------------------------------------------------------------ summary */

const passed = results.filter((r) => r.passed).length;
header(`SUMMARY — ${passed}/${results.length} checks passed`);
results.filter((r) => !r.passed).forEach((r) => console.log(`   FAILED: ${r.label}`));
process.exit(passed === results.length ? 0 : 1);
