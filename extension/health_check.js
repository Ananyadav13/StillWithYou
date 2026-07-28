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
  const { log } = self.SWY;
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
      Object.keys(self.SWY.selectors.TARGETS).forEach((name) => {
        const spec = self.SWY.selectors.TARGETS[name];
        const found = self.SWY.selectors.resolve(name);

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
      return { healthy: false, degraded: true, checkedAt: new Date().toISOString(), targets };
    }

    return { healthy, degraded, checkedAt: new Date().toISOString(), targets };
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

  /** Inspect, log, and show or clear the indicator. Returns the report. */
  function run(reason) {
    const report = inspect();

    log(
      'health_check',
      {
        reason: reason || 'load',
        healthy: report.healthy,
        degraded: report.degraded,
        targets: report.targets,
      },
      report.healthy ? 'info' : 'warn',
    );

    if (report.healthy) {
      removeIndicator();
    } else {
      showIndicator();
    }

    return report;
  }

  self.SWY.health = { run, inspect, showIndicator, removeIndicator, INDICATOR_ID };
})();
