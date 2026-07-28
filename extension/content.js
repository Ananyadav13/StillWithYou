/* Content script. Runs in WhatsApp Web's page, in the extension's isolated world.
 *
 * Everything it is allowed to do is here: find the compose box, read its text on a
 * pause, ask the service worker to analyse it, render an overlay. Nothing else touches
 * WhatsApp.
 *
 * THE THINGS THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------------
 * Listed because they are all one line away, and this is the file where someone adds
 * them without noticing they have crossed the boundary in docs/phase5-scope.md:
 *
 *   - it never writes to the compose box (no textContent, no innerHTML, no execCommand,
 *     no input events) — "apply the suggested rewrite" is the obvious next feature and
 *     the exact line this phase does not cross;
 *   - it never calls preventDefault, and attaches no keydown handler at all, so no bug
 *     in it can eat somebody's Enter;
 *   - it binds nothing to the send button, and does not attempt to detect sends;
 *   - it never patches fetch, XHR or WebSocket, and never enters the page's main world;
 *   - it observes the compose box's own subtree only, not the message list, so the
 *     conversation transcript is never read.
 *
 * The listeners it does attach are `input` (bubbling, non-capture, on the compose box)
 * and a MutationObserver scoped to the footer. Neither can alter behaviour: an input
 * listener that only reads cannot change what WhatsApp does with the event, and a
 * MutationObserver is by construction passive.
 */

(function main() {
  const { config, log } = self.SWY;

  /* ---------------------------------------------------------------------------
   * Step 1: prove the content script loaded at all.
   * ------------------------------------------------------------------------- */
  log('content_script_loaded', {
    version: '0.1.0',
    href: location.origin + location.pathname,
    debounce_ms: config.DEBOUNCE_MS,
    heat_threshold: config.HEAT_THRESHOLD,
  });

  /* Set true to log captured draft text. Step 3's evidence needs it; normal operation
   * must not have it, because a user's unsent messages have no business in a console.
   * The banner already proves capture works, so this stays off outside verification. */
  const LOG_CAPTURED_TEXT = false;

  let debounceTimer = null;
  let attachedBox = null;
  let lastAnalyzed = null;
  let inFlightFor = null;

  /* ---------------------------------------------------------------------------
   * Reading the draft.
   * ------------------------------------------------------------------------- */

  /* `innerText` rather than `textContent`: WhatsApp's compose box is a contenteditable
   * that renders each line as its own element and emoji as <img> nodes with alt text.
   * textContent would run lines together into one word and drop emoji entirely, both of
   * which change what the analyzer sees. */
  function readDraft(box) {
    try {
      return (box.innerText || '').replace(/ /g, ' ').trim();
    } catch (error) {
      log('draft_read_failed', { error: String(error && error.message).slice(0, 160) }, 'warn');
      return '';
    }
  }

  function analyze(text) {
    if (inFlightFor === text) return; /* Already asking about exactly this draft. */
    inFlightFor = text;

    let settled = false;
    /* The service worker holds its own 3s deadline in api.js. This second one is not
     * redundant: it covers the case where the *worker itself* never answers — a
     * terminated MV3 service worker that fails to wake, or an extension reload that
     * drops the message channel. In both, sendMessage's callback simply never fires,
     * and without this the extension would wait forever on a page the user is using. */
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      inFlightFor = null;
      log('analysis_no_response', { chars: text.length, after_ms: config.REQUEST_TIMEOUT_MS + 500 }, 'warn');
    }, config.REQUEST_TIMEOUT_MS + 500);

    try {
      chrome.runtime.sendMessage({ type: 'SWY_ANALYZE', content: text }, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        inFlightFor = null;

        /* Set when the extension was reloaded or the worker died mid-request. Reading
         * it is also what suppresses the "unchecked runtime.lastError" console noise. */
        if (chrome.runtime && chrome.runtime.lastError) {
          log('analysis_channel_closed', {
            error: String(chrome.runtime.lastError.message).slice(0, 160),
          }, 'warn');
          return;
        }

        if (!result || !result.ok) {
          /* The user sees nothing. This is the whole graceful-failure contract: a
           * WhatsApp Web user who has never heard of this project must not be shown an
           * error from it, and a backend that is down is our problem, not theirs. */
          log('analysis_unavailable', {
            reason: (result && result.reason) || 'no_result',
            elapsed_ms: result && result.elapsedMs,
            chars: text.length,
          }, 'warn');
          self.SWY.banner.remove();
          return;
        }

        const analysis = result.analysis;
        log('analysis_result', {
          mood: analysis.mood,
          heat_score: analysis.heat_score,
          toxicity_score: analysis.toxicity_score,
          language: analysis.language,
          source: analysis.source,
          cached: analysis.cached,
          elapsed_ms: result.elapsedMs,
          over_threshold: analysis.heat_score >= config.HEAT_THRESHOLD,
        });

        self.SWY.banner.render(text, analysis);
      });
    } catch (error) {
      clearTimeout(guard);
      settled = true;
      inFlightFor = null;
      /* Throws here when the extension context has been invalidated — i.e. it was
       * reloaded while this page stayed open. Nothing to do but stop quietly. */
      log('analysis_send_failed', { error: String(error && error.message).slice(0, 160) }, 'warn');
    }
  }

  function onDraftChanged() {
    let box;
    try {
      box = self.SWY.selectors.composeBox();
    } catch (_) {
      box = null;
    }

    if (!box) {
      /* Lost the compose box after having had it: re-run the health check so the
       * indicator appears rather than the extension just going quiet. */
      self.SWY.health.run('compose_box_lost');
      return;
    }

    const text = readDraft(box);

    if (LOG_CAPTURED_TEXT) {
      log('draft_captured', { chars: text.length, text });
    } else {
      log('draft_captured', { chars: text.length });
    }

    if (text.length < config.MIN_CHARS) {
      /* Cleared or trivially short: drop any banner, since it described text that no
       * longer exists. */
      self.SWY.banner.remove();
      lastAnalyzed = null;
      return;
    }

    if (text === lastAnalyzed) return; /* Pause with no edit since the last analysis. */
    lastAnalyzed = text;

    analyze(text);
  }

  function scheduleAnalysis() {
    if (debounceTimer) clearTimeout(debounceTimer);
    /* The debounce is the whole reason this is affordable. Without it every keystroke
     * would be a request; see config.js on why 1500ms and why this departs from the
     * main app rather than copying it. */
    debounceTimer = setTimeout(onDraftChanged, config.DEBOUNCE_MS);
  }

  /* ---------------------------------------------------------------------------
   * Attachment.
   *
   * WhatsApp replaces the compose box whenever the user switches conversation, so this
   * cannot be a one-time bind at load. The observer below re-attaches when the element
   * is swapped, and re-attachment is idempotent — guarded on the element identity, not
   * on a boolean, because a boolean would go stale the moment the node was replaced.
   * ------------------------------------------------------------------------- */

  function attach() {
    let box;
    try {
      box = self.SWY.selectors.composeBox();
    } catch (_) {
      box = null;
    }

    if (!box) return false;
    if (box === attachedBox) return true;

    try {
      /* Bubbling phase, read-only. A capture-phase listener could observe the event
       * before WhatsApp does, which is a step towards being able to interfere with it;
       * bubbling keeps this strictly downstream of their own handling. */
      box.addEventListener('input', scheduleAnalysis, { passive: true });
      attachedBox = box;
      self.SWY.banner.remove();
      lastAnalyzed = null;
      log('compose_box_attached', { tag: box.tagName.toLowerCase() });
      return true;
    } catch (error) {
      log('attach_failed', { error: String(error && error.message).slice(0, 160) }, 'error');
      return false;
    }
  }

  /* ---------------------------------------------------------------------------
   * Boot.
   * ------------------------------------------------------------------------- */

  function boot() {
    try {
      /* Health first, before anything is bound. If the DOM has moved, the user finds
       * out immediately rather than after a pause that produces nothing.
       *
       * On a cold load this is almost always `idle` — WhatsApp shows a splash screen
       * until a chat is opened, so there is genuinely nothing to attach to yet. The
       * observer below picks it up the moment a conversation is opened. */
      const report = self.SWY.health.run('load');

      if (report.state === 'attached') attach();

      /* WhatsApp Web renders its chat pane asynchronously, so the compose box often
       * does not exist yet at document_idle, and it is replaced on every conversation
       * switch. Observing document.body for childList changes covers both. The callback
       * is cheap: attach() short-circuits on element identity, and does no work at all
       * once bound to the current box.
       *
       * This observes structure only. It never reads message content, and it is not
       * scoped to the message list. */
      /* Coalesced. WhatsApp Web mutates its DOM many times a second — running the
       * attach/health path on every callback produced dozens of duplicate console
       * lines per second and did the same DOM queries over and over for no benefit.
       * 250ms is far below human reaction time, so re-attaching after a conversation
       * switch still feels instant. */
      let observerTimer = null;
      const onMutation = () => {
        try {
          if (attachedBox && !document.body.contains(attachedBox)) {
            attachedBox = null;
            self.SWY.banner.remove();
          }
          if (!attach()) {
            /* Could not attach. `run` distinguishes "no chat open" (idle, silent) from
             * "chat open but the compose box is gone" (detached, indicator shown), so
             * this is safe to call on every settle. */
            self.SWY.health.run('observer');
          }
        } catch (_) {
          /* Rule 1 again: nothing thrown from an observer callback reaches the page,
           * but an exception here would silently kill re-attachment. */
        }
      };

      const observer = new MutationObserver(() => {
        if (observerTimer) clearTimeout(observerTimer);
        observerTimer = setTimeout(onMutation, 250);
      });

      observer.observe(document.body, { childList: true, subtree: true });

      log('observer_started', {});

      /* Config last, and NOT awaited. Everything above is already running on the frozen
       * snapshot, so a slow or unreachable GitHub delays nothing. When a newer config
       * lands, re-run the health check and try to attach with the new selectors — which
       * is the whole payoff: a selector fix pushed to a JSON file takes effect here,
       * with no code change and no extension reload. */
      self.SWY.remoteConfig.onInstalled((source) => {
        log('config_applied', { source });
        attachedBox = null;
        if (self.SWY.health.run('config_installed').state === 'attached') attach();
      });

      void self.SWY.remoteConfig.refresh();
    } catch (error) {
      /* Absolute last line of defence. Nothing from this extension reaches WhatsApp's
       * page context as an uncaught error. */
      log('boot_failed', { error: String(error && error.message).slice(0, 200) }, 'error');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
