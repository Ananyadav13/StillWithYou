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

  /* ---------------------------------------------------------------------------
   * FRAGMENT TRIGGER — three constants, chosen together, and currently DISABLED.
   *
   * These are documented as one block because they are not independent. The trigger
   * length decides which messages can ever be examined; the threshold decides whether
   * what it sees is acted on. Tuning either alone produces a number that looks defensible
   * and means nothing.
   *
   * WHAT IT WAS FOR
   * ---------------
   * The debounce cannot catch someone who types continuously and sends without pausing.
   * Measured on the real site: three of five messages produced `draft_captured chars:0` -
   * the pause timer fired after the message was already gone, read an empty box, and
   * never requested analysis. Those three were the short, fast, escalating ones, i.e.
   * exactly the population this product exists to catch. This was the attempt to close
   * that gap by taking one look mid-typing.
   *
   * WHY IT IS OFF
   * -------------
   * Measured across 40 messages x 4 trigger lengths x 3 thresholds - 20 messages from
   * the Phase 3 corpus (60-90 chars) and 20 short messages written blind for this test
   * (10-19 chars), fragments always cut at a word boundary. Best cell in the entire
   * surface:
   *
   *     L=12, threshold 0.45  ->  2/10 heated caught (20%), 0/10 false fires
   *
   * Four of five heated messages get no warning at any setting. On the long-message
   * corpus the catch rate is 0-10% at every cell. There is no pair worth shipping, so
   * the honest state is off with the gap documented rather than a feature that almost
   * never fires.
   *
   * THE MESSAGE-LENGTH FLOOR, AND THE DEEPER REASON
   * -----------------------------------------------
   * A trigger of L characters can only ever examine messages of at least L characters.
   * Measured reachability on the short set: L=10 reaches 10/10 heated, L=12 reaches
   * 9/10, L=14 reaches 5/10, L=16 reaches 5/10. So a long trigger is structurally blind
   * to short messages - and short messages are the failing population.
   *
   * But shortening the trigger does not rescue it, and the reason is the interesting
   * part. "you are a disgrace" - the message this whole investigation started from - is
   * never caught at any setting:
   *
   *     L=10   0.18   "you are a"
   *     L=12   0.18   "you are a"
   *     L=14   unreachable (nearest word boundary is char 9)
   *
   * The heat lives in the word being TYPED. Cutting at a word boundary always truncates
   * immediately before it. Measured mid-word for contrast, n=4 and unrepresentative:
   * "you are a disg" scores 0.59 against "you are a" at 0.18. That suggests the
   * word-boundary rule, adopted to avoid feeding the tokenizer odd input, is what removes
   * the signal - but four hand-picked examples are exactly the evidence that produced the
   * discredited 0.50 in the first place, so it is logged as an untested hypothesis, not
   * a finding. Testing it properly means re-running the full grid mid-word.
   *
   * Fragment scores are NOT noisier at short lengths - mean |fragment - full| is flat at
   * ~0.14 across all four lengths on the corpus set. The failure is not noise. Short
   * fragments score uniformly LOW, so heated messages are systematically underestimated
   * (worst divergences: -0.45, -0.29, all heated, none calm-overestimated). Flatness, not
   * variance, is what kills it.
   * ------------------------------------------------------------------------- */

  /* Off. See above. With it off, the silent-failure gap in docs/phase5-scope.md stays
   * open: a message typed and sent inside DEBOUNCE_MS is never analysed. That is a known
   * documented hole, which is a better state than a feature firing on 2 of 10 genuine
   * warnings. */
  FRAGMENT_TRIGGER_ENABLED: false,

  /* The best pair the measurement found, retained so that any future attempt starts from
   * a measured point rather than a guess. They are NOT good enough to enable, and should
   * not be read as a recommendation - 20% catch is the ceiling they represent. */
  FRAGMENT_TRIGGER_CHARS: 12,
  PROVISIONAL_HEAT_THRESHOLD: 0.45,

  /* How long the compose box must stay missing, while a conversation is open, before the
   * health check calls it an outage.
   *
   * WhatsApp replaces the compose box node routinely - `compose_box_attached` recurs
   * throughout a normal session. Between the old node going and the new one arriving,
   * `#main` still matches, so the check briefly concludes "chat open, compose box gone"
   * and shows the "couldn't attach" indicator. Measured on the real site: two such
   * episodes recovered on their own after ~5.7s and ~32s.
   *
   * 8s clears the 5.7s transient while still reporting anything longer. The cost is that
   * a genuine DOM break is announced 8s late, which is nothing against a failure measured
   * in days. The alternative fix - tightening `conversationOpen` to require the compose
   * box - was rejected: it silences the false positive and the true positive together,
   * which is the wrong direction for a design whose premise is that absence of a warning
   * must never read as calm. */
  DETACHED_GRACE_MS: 8000,

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
