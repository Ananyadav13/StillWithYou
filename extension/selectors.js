/* DOM selector resilience layer.
 *
 * This is the load-bearing file of Phase 5, and it exists because of a fact stated at
 * the top of docs/phase5-scope.md: WhatsApp Web's DOM is unversioned, undocumented and
 * can change in any deploy, including one that ships while a tab is open. The class
 * names are build-generated. There is no contract here and never will be.
 *
 * So the design assumption is not "these selectors work". It is "these selectors will
 * stop working, and the interesting question is what happens on that day".
 *
 * Three rules, and every one of them is about that day:
 *
 *   1. RESOLUTION NEVER THROWS. Every target returns an element or `null`. An exception
 *      escaping into WhatsApp's page context is the one outcome worse than not working,
 *      because it makes StillWithYou's bug look like WhatsApp's bug to the person using
 *      it, and because a throw part-way through setup can leave listeners half-attached.
 *
 *   2. FAILURE IS RECORDED, NOT SWALLOWED. A miss logs a structured warning naming the
 *      target, every selector attempted and the time, and increments a persisted
 *      counter in chrome.storage.local. Counters survive reloads, so "it broke sometime
 *      last Tuesday" is answerable after the fact rather than only while watching.
 *
 *   3. FALLBACK CHAINS, NOT SINGLE SELECTORS. Each target lists several selectors from
 *      most to least specific. This is not belt-and-braces: the specific ones are
 *      attribute values WhatsApp owns and rotates, while the last one in each chain is
 *      a structural/ARIA property that would only change in a genuine redesign. A
 *      partial break therefore degrades to a slower, broader match instead of to
 *      nothing — and `matchedIndex` in the health report says which rung was used, so
 *      drift is visible before it becomes an outage.
 *
 * WHAT THIS FILE MUST NEVER GROW
 * ------------------------------
 * `sendButton` is resolved and NEVER BOUND. It exists purely as a second canary for the
 * health check: if the compose box still resolves but the send button does not, the DOM
 * has changed in a way that has not broken text capture yet but probably will. One
 * selector failing is a weaker signal than two disagreeing.
 *
 * Do not attach a click handler to it. Do not read from it. Do not use it to detect
 * sends. The read-only boundary in docs/phase5-scope.md forbids intercepting, blocking
 * or observing WhatsApp's own send path, and this is the exact file where someone would
 * cross that line without meaning to, because the element is already right here.
 */

self.SWY = self.SWY || {};

(function initSelectors() {
  const { config, log } = self.SWY;

  /* The selectors themselves.
   *
   * Every value below is a point-in-time observation of a third party's private DOM. It
   * carries no guarantee and is expected to rot. That is the whole premise, not a
   * disclaimer. */
  const TARGETS = {
    composeBox: {
      /* Critical: without this there is nothing to read and the extension has no
       * function at all. */
      critical: true,
      description: 'the message compose box',
      selectors: [
        /* WhatsApp tags the footer compose box with data-tab="10". Most specific, most
         * likely to be the first thing to change. */
        'footer div[contenteditable="true"][data-tab="10"]',
        /* Same element without the tab number, in case only the number rotates. */
        '#main footer div[contenteditable="true"]',
        /* Structural: the compose box is the contenteditable textbox inside the
         * conversation's footer. Survives class and data-attribute churn. */
        'footer div[role="textbox"][contenteditable="true"]',
        /* Last rung. Broad enough to match the search box too, which is why it is last
         * and why `pickComposeBox` below prefers a footer-scoped match. Present only so
         * a redesign degrades to "slightly wrong element" rather than "nothing". */
        'div[role="textbox"][contenteditable="true"]',
      ],
    },

    sendButton: {
      /* Not critical. Losing it degrades the health signal, not the function — and
       * nothing is ever bound to it, so losing it breaks no behaviour. */
      critical: false,
      description: 'the send button (health canary only — never bound)',
      selectors: [
        'button[aria-label="Send"]',
        'footer button[data-tab="11"]',
        'span[data-icon="send"]',
        'footer button[aria-label]',
      ],
    },
  };

  /* ---------------------------------------------------------------------------
   * Failure counters.
   *
   * chrome.storage.local rather than a module-level variable because the useful
   * question is "how long has this been broken", and that outlives a page load. Writes
   * are fire-and-forget and can never reject into a caller: a storage failure must not
   * be able to break DOM resolution, which is the thing that actually matters.
   * ------------------------------------------------------------------------- */

  function recordFailure(target) {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        return; /* Running outside an extension context, e.g. the local DOM fixture. */
      }
      const key = config.FAILURE_STORE_KEY;
      chrome.storage.local.get([key], (stored) => {
        try {
          if (chrome.runtime && chrome.runtime.lastError) return;
          const failures = (stored && stored[key]) || {};
          const previous = failures[target] || { count: 0, firstSeen: null, lastSeen: null };
          const now = new Date().toISOString();
          failures[target] = {
            count: previous.count + 1,
            firstSeen: previous.firstSeen || now,
            lastSeen: now,
          };
          chrome.storage.local.set({ [key]: failures }, () => {
            /* Reading lastError is what suppresses the "unchecked runtime.lastError"
             * console noise; there is nothing useful to do about the error itself. */
            void (chrome.runtime && chrome.runtime.lastError);
          });
        } catch (_) {
          /* See rule 1. */
        }
      });
    } catch (_) {
      /* See rule 1. */
    }
  }

  /* ---------------------------------------------------------------------------
   * Resolution.
   * ------------------------------------------------------------------------- */

  /* One selector attempt. Returns an element or null, and never throws — note that
   * querySelector itself throws SyntaxError on a malformed selector, which is exactly
   * what a typo'd hand-edit produces, so the try/catch is load-bearing rather than
   * defensive habit. */
  function trySelector(selector, root) {
    try {
      return (root || document).querySelector(selector) || null;
    } catch (error) {
      log(
        'selector_malformed',
        { selector, error: String(error && error.message).slice(0, 160) },
        'warn',
      );
      return null;
    }
  }

  /**
   * Resolve a logical target.
   *
   * @returns {{element: Element|null, target: string, matchedSelector: string|null,
   *            matchedIndex: number, attempted: string[]}}
   */
  function resolve(target) {
    const spec = TARGETS[target];
    const attempted = [];

    if (!spec) {
      log('selector_unknown_target', { target }, 'warn');
      return { element: null, target, matchedSelector: null, matchedIndex: -1, attempted };
    }

    for (let i = 0; i < spec.selectors.length; i += 1) {
      const selector = spec.selectors[i];
      attempted.push(selector);
      const element = trySelector(selector);
      if (element) {
        if (i > 0) {
          /* Not a failure, but not nothing either: the preferred selector stopped
           * matching and something further down the chain caught it. This is what DOM
           * drift looks like *before* it becomes an outage, and it is the signal worth
           * having, because it arrives while there is still time to react. */
          log('selector_degraded', {
            target,
            matched: selector,
            matchedIndex: i,
            skipped: spec.selectors.slice(0, i),
          }, 'warn');
        }
        return { element, target, matchedSelector: selector, matchedIndex: i, attempted };
      }
    }

    /* Every rung failed. This is the day the file was written for. */
    log(
      'selector_failed',
      {
        target,
        description: spec.description,
        critical: spec.critical,
        attempted,
        url: location.href.split('?')[0],
      },
      'warn',
    );
    recordFailure(target);

    return { element: null, target, matchedSelector: null, matchedIndex: -1, attempted };
  }

  /** Just the element, for callers that do not care how it was found. */
  function element(target) {
    return resolve(target).element;
  }

  /* The last rung of the composeBox chain also matches the chat-search box, so prefer a
   * match that is inside a footer when the chain had to fall that far. Cheap, and it
   * stops the degraded path from quietly analysing the user's search query — which
   * would be both wrong and a privacy problem, since a search box is not a draft. */
  function composeBox() {
    const found = resolve('composeBox');
    if (!found.element || found.matchedIndex < 3) return found.element;
    try {
      const scoped = found.element.closest('footer');
      if (!scoped) {
        log('compose_box_outside_footer', { matched: found.matchedSelector }, 'warn');
        return null;
      }
    } catch (_) {
      return null;
    }
    return found.element;
  }

  /** Read the persisted failure counts. Resolves to `{}` on any problem. */
  function readFailures() {
    return new Promise((resolve_) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
          resolve_({});
          return;
        }
        chrome.storage.local.get([config.FAILURE_STORE_KEY], (stored) => {
          void (chrome.runtime && chrome.runtime.lastError);
          resolve_((stored && stored[config.FAILURE_STORE_KEY]) || {});
        });
      } catch (_) {
        resolve_({});
      }
    });
  }

  self.SWY.selectors = {
    TARGETS,
    resolve,
    element,
    composeBox,
    readFailures,
    criticalTargets: () => Object.keys(TARGETS).filter((name) => TARGETS[name].critical),
  };
})();
