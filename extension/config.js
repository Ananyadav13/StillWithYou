/* Every tunable value in the extension, in one place.
 *
 * Content scripts declared in the manifest share one isolated-world global scope and
 * run in manifest order, so this file just defines `self.SWY` and later files hang
 * things off it. No bundler, no modules, no build step — the extension is loaded
 * unpacked and read as-is, which is the right trade for a proof of concept whose whole
 * point is that its failure modes should be legible.
 */

self.SWY = self.SWY || {};

self.SWY.config = {
  /* Distinct enough to grep for in a console that is already full of WhatsApp's own
   * logging. Every line the extension emits carries this prefix. */
  MARKER: '[StillWithYou]',

  /* Where the backend lives.
   *
   * 127.0.0.1 rather than localhost deliberately: `localhost` costs ~2s per request on
   * this machine because it resolves IPv6 first and falls back, which is already in the
   * project's gotchas list. A 2s DNS penalty against a 3s deadline is most of the
   * budget spent before the request starts.
   *
   * This string must stay in sync with `host_permissions` in manifest.json. If they
   * disagree the fetch fails with a CORS error rather than anything that names the
   * real problem, so they are commented in both places. */
  API_BASE: 'http://127.0.0.1:8000',

  /* Wait for a typing pause before analysing.
   *
   * NOTE this is a DEPARTURE from the main app, not an imitation of it. The React app
   * does not debounce at all — it analyses on send only, and the comment on
   * `sendMessage` in useChat.ts argues explicitly against debouncing (a 200-character
   * message is ~1 request on send versus 15-30 debounced). Phase 2 Step 4 measured it:
   * 0 backend requests in a 20s typing window, 1 on send.
   *
   * The extension cannot copy that, because "analyse on send" means knowing when the
   * user sends, which means a listener on the send button or on Enter — exactly what
   * the read-only boundary in docs/phase5-scope.md forbids. The constraint that keeps
   * this extension safe is the same constraint that forces it into the more expensive
   * request pattern.
   *
   * 1500ms rather than the ~400ms a typeahead would use: this is not autocomplete, and
   * a pause that long is closer to "stopped to think" than "moved between words" —
   * which is the moment the product is actually aiming at. */
  DEBOUNCE_MS: 1500,

  /* Client-side deadline on the analysis call.
   *
   * Same 3s and the same reasoning as Phase 4 Step 6 and `gemini_timeout_seconds`:
   * comfortable margin over the measured end-to-end window (422-638ms in the main app;
   * 44-55ms warm for /analyze-preview), short enough that a hung backend does not leave
   * work pending on a page the user is actively trying to use. Above all it must never
   * be possible for a slow backend to make WhatsApp Web feel slow. */
  REQUEST_TIMEOUT_MS: 3000,

  /* Minimum heat_score that shows a banner.
   *
   * Chosen and justified in frontend/src/config/nudge.ts — measured over all 45 corpus
   * fixtures, deliberately NOT set to the fitted optimum of 0.23, and biased to
   * under-warn because an unrequested overlay on somebody else's application costs the
   * user more on a false positive than a miss does. Read that file before changing this
   * number; the two must move together. */
  HEAT_THRESHOLD: 0.35,

  /* Don't analyse a draft too short to mean anything. Two-character messages are
   * "ok"/"hm" and cost an inference to learn nothing. */
  MIN_CHARS: 8,

  /* chrome.storage.local key holding per-target selector failure counts. */
  FAILURE_STORE_KEY: 'selector_failures',
};

/* Structured logging, so a console paste is parseable evidence rather than prose.
 * Shape matches the backend's JSON log lines closely enough to read side by side.
 *
 * Wrapped because console itself can be patched by the host page. It is not supposed to
 * be possible for a broken log call to take the extension down with it. */
self.SWY.log = function log(event, fields = {}, level = 'info') {
  try {
    const line = {
      ts: new Date().toISOString(),
      event,
      ...fields,
    };
    const method = level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info';
    // eslint-disable-next-line no-console
    console[method](`${self.SWY.config.MARKER} ${JSON.stringify(line)}`);
  } catch (_) {
    /* A logger that can throw is worse than no logger. */
  }
};
