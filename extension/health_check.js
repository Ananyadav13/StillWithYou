/* Health check: does the extension still have a grip on the page?
 *
 * Runs on load, and again whenever the compose box goes missing at read time.
 *
 * WHY THIS IS VISIBLE RATHER THAN A LOG LINE
 * ------------------------------------------
 * The failure this whole phase is organised around is the *quiet* one. An extension
 * that silently stops attaching shows no banner — and "no banner" is exactly what a
 * calm message looks like. The user would read a broken tool as a verdict that their
 * message is fine, at the precise moment they were relying on a second opinion. Absence
 * of a warning must never be mistakable for a warning that did not fire.
 *
 * So a detached extension says so, on screen. That is the entire justification for
 * putting any UI on the page in a failure state.
 *
 * WHY IT IS SMALL AND DULL
 * ------------------------
 * It is also, on the same reasoning as everything else in Phase 5, somebody else's
 * application. A modal, a toast that steals focus, or anything red would be a
 * third-party extension shouting about its own problems over a conversation the user is
 * having. A small grey chip in a corner, dismissible, is the most it has earned. It
 * announces itself to a screen reader politely and never takes focus.
 */

self.SWY = self.SWY || {};

(function initHealthCheck() {
  const { config, log } = self.SWY;
  const INDICATOR_ID = 'swy-health-indicator';

  /**
   * Check every target and report. Never throws.
   *
   * @returns {{healthy: boolean, checkedAt: string, targets: object, degraded: boolean}}
   */
  function inspect() {
    const targets = {};
    let healthy = true;
    let degraded = false;

    try {
      /* No conversation open -> nothing to attach to, and that is not a fault.
       *
       * This case used to be reported as a failure, which meant the indicator appeared
       * on every single page load before the user clicked a chat. An indicator that
       * fires during normal operation is worse than none: it teaches the user to
       * dismiss it, so it carries no information on the day the DOM actually moves. The
       * state is reported as `idle` and reads as healthy. */
      if (!self.SWY.selectors.isConversationOpen()) {
        return {
          healthy: true,
          degraded: false,
          state: 'idle',
          reason: 'no_conversation_open',
          checkedAt: new Date().toISOString(),
          targets,
        };
      }
    } catch (_) {
      /* Fall through to the full check rather than assuming either answer. */
    }

    try {
      Object.keys(self.SWY.selectors.TARGETS).forEach((name) => {
        const spec = self.SWY.selectors.TARGETS[name];
        /* record: false — the health check is a reporter, not an incident. Counting
         * every inspection would make `selector_failures` a count of health checks. */
        const found = self.SWY.selectors.resolve(name, { record: false });

        targets[name] = {
          found: Boolean(found.element),
          critical: spec.critical,
          matchedSelector: found.matchedSelector,
          /* Which rung of the fallback chain answered. 0 is the preferred selector;
           * anything higher is drift that has not broken anything yet. */
          matchedIndex: found.matchedIndex,
          attempted: found.attempted.length,
        };

        if (!found.element && spec.critical) healthy = false;
        if (found.element && found.matchedIndex > 0) degraded = true;
        /* A non-critical target going missing is not an outage, but it is the second
         * canary — worth carrying in the report even though it does not flip `healthy`. */
        if (!found.element && !spec.critical) degraded = true;
      });
    } catch (error) {
      /* An exception in the health check must not become the outage it is checking for. */
      log('health_check_threw', { error: String(error && error.message).slice(0, 200) }, 'error');
      return {
        healthy: false, degraded: true, state: 'detached',
        reason: 'health_check_threw', checkedAt: new Date().toISOString(), targets,
      };
    }

    return {
      healthy,
      degraded,
      /* attached  = a chat is open and the compose box was found
       * detached  = a chat is open and it was NOT found -> the real outage
       * idle      = no chat open (returned earlier), not a fault */
      state: healthy ? 'attached' : 'detached',
      reason: healthy ? null : 'compose_box_not_found',
      checkedAt: new Date().toISOString(),
      targets,
    };
  }

  function removeIndicator() {
    try {
      const existing = document.getElementById(INDICATOR_ID);
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    } catch (_) {
      /* Nothing to do — and nothing worth throwing over. */
    }
  }

  function showIndicator() {
    try {
      if (document.getElementById(INDICATOR_ID)) return; /* Already up. */
      if (!document.body) return;

      const chip = document.createElement('div');
      chip.id = INDICATOR_ID;
      chip.className = 'swy-health';
      chip.setAttribute('role', 'status');
      chip.setAttribute('aria-live', 'polite');

      const text = document.createElement('span');
      /* Names WhatsApp as the likely cause on purpose. "Something went wrong" would
       * leave the user suspecting their own setup; the honest and more useful message
       * is that the page this attaches to probably changed. */
      text.textContent = "StillWithYou couldn't attach — WhatsApp may have updated";

      const dismiss = document.createElement('button');
      dismiss.className = 'swy-health__dismiss';
      dismiss.type = 'button';
      dismiss.textContent = '×';
      dismiss.setAttribute('aria-label', 'Dismiss StillWithYou status');
      dismiss.addEventListener('click', removeIndicator);

      chip.appendChild(text);
      chip.appendChild(dismiss);
      /* Appended to body in our own fixed-position container, never inserted into
       * WhatsApp's tree — it cannot shift their layout or be caught by their event
       * delegation. Same rule as the banner. */
      document.body.appendChild(chip);
    } catch (error) {
      log('health_indicator_failed', { error: String(error && error.message).slice(0, 200) }, 'error');
    }
  }

  /* The health check is called from the MutationObserver, and WhatsApp Web mutates
   * many times a second. Logging every call flooded the console with dozens of
   * identical lines and buried anything real. Only state CHANGES are logged. */
  let lastLoggedState = null;

  /* When the compose box first went missing while a conversation was open. The indicator
   * waits DETACHED_GRACE_MS from this point - WhatsApp replaces the compose box node
   * routinely, and a replacement gap is not an outage. */
  let detachedSince = null;

  /** Inspect, apply the grace period, log on change, show or clear the indicator. */
  function run(reason) {
    const report = inspect();

    /* Grace period FIRST, before anything is logged or shown.
     *
     * `inspect()` reports the instantaneous truth; whether that truth has PERSISTED long
     * enough to count as an outage is decided here. Doing it before the log matters -
     * otherwise the console reports `detached` for episodes the indicator deliberately
     * suppresses, which is exactly the kind of disagreement between what is logged and
     * what is believed that makes a log untrustworthy.
     *
     * WhatsApp replaces the compose box node routinely (`compose_box_attached` recurs
     * all session), and a replacement gap is not an outage. See DETACHED_GRACE_MS. */
    if (report.state === 'detached') {
      if (detachedSince === null) detachedSince = Date.now();
      report.heldForMs = Date.now() - detachedSince;
      if (report.heldForMs < config.DETACHED_GRACE_MS) {
        report.state = 'detaching';
        report.healthy = true;
      }
    } else {
      detachedSince = null;
    }

    if (report.state !== lastLoggedState) {
      log(
        'health_check',
        {
          reason: reason || 'load',
          state: report.state,
          from: lastLoggedState,
          healthy: report.healthy,
          degraded: report.degraded,
          detail: report.reason,
          held_for_ms: report.heldForMs,
          targets: report.targets,
        },
        report.healthy ? 'info' : 'warn',
      );
      lastLoggedState = report.state;
    }

    /* Only a `detached` that survived the grace period earns the indicator. `idle` is
     * normal, `attached` is working, and `detaching` is a node swap in progress -
     * showing it for any of those is the crying-wolf failure this design exists to
     * avoid. */
    if (report.state === 'detached') {
      /* Record the incident here, on the transition into a BELIEVED outage.
       *
       * `inspect()` resolves with `record: false` because a reporter must not count
       * itself as an outage, and nothing else records it either: when the state is
       * detached, `content.js` skips `attach()`, so the recording path in `resolve()` is
       * never reached. The health check is the right owner anyway - it is the only thing
       * that knows the difference between a DOM change, an unopened chat, and a node
       * swap. `resolve`'s own latch keeps this to one entry per transition. */
      try {
        Object.keys(report.targets).forEach((name) => {
          if (!report.targets[name].found && self.SWY.selectors.TARGETS[name].critical) {
            self.SWY.selectors.resolve(name, { record: true });
          }
        });
      } catch (_) {
        /* Recording an incident must never become one. */
      }
      showIndicator();
    } else {
      removeIndicator();
    }

    return report;
  }

  self.SWY.health = { run, inspect, showIndicator, removeIndicator, INDICATOR_ID };
})();
