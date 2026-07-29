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

  /* ---------------------------------------------------------------------------
   * FROZEN SNAPSHOT - the only selector data that ships inside the extension.
   *
   * A copy of extension-config/selectors.json taken at build time. LAST RESORT only:
   * used when the remote config cannot be fetched AND no last-known-good is cached,
   * i.e. a first-ever run with no network.
   *
   * DO NOT MAINTAIN BY HAND. The JSON file is the source of truth - a selector fix goes
   * there, because that is the copy already-installed extensions pick up without a code
   * change. Re-sync afterwards: `node fixtures/sync-snapshot.mjs --fix`.
   * ------------------------------------------------------------------------- */
  const FROZEN_CONFIG = {
    "version": 3,
    "updated": "2026-07-29T02:00:00Z",
    "targets": {
      "composeBox": {
        "critical": true,
        "description": "the message compose box",
        "selectors": [
          "footer div[contenteditable=\"true\"][data-tab=\"10\"]",
          "#main footer div[contenteditable=\"true\"]",
          "footer div[role=\"textbox\"][contenteditable=\"true\"]",
          "div[role=\"textbox\"][contenteditable=\"true\"]"
        ]
      },
      "sendButton": {
        "critical": false,
        "description": "the send button (health canary only - never bound)",
        "selectors": [
          "button[aria-label=\"Send\"]",
          "footer button[data-tab=\"11\"]",
          "span[data-icon=\"send\"]",
          "footer button[aria-label]"
        ]
      }
    },
    "conversationOpen": [
      "#main",
      "div[role=\"application\"] footer",
      "footer div[contenteditable=\"true\"]"
    ]
  };

  /* The config actually in use. Starts as the snapshot so the extension has working
   * selectors synchronously, before any network or storage call - the load sequence must
   * never wait on config. `install()` upgrades it in place when something better lands. */
  let active = FROZEN_CONFIG;
  let activeSource = 'hardcoded';

  /* Is a conversation actually open?
   *
   * A PRECONDITION, not a canary, and the distinction is why it exists. WhatsApp renders
   * no compose box until a chat is opened - the landing state is a splash screen.
   * Without this the extension cannot tell "WhatsApp changed its DOM" (a real outage)
   * from "the user hasn't opened a chat yet" (normal, every single load), and it reported
   * the second as the first. An indicator that fires during normal operation trains the
   * user to dismiss it, so it carries no information on the day the DOM really moves.
   *
   * Kept out of TARGETS deliberately: everything there is something whose absence is a
   * fault; this is something whose absence is just Tuesday. */
  function isConversationOpen() {
    for (const selector of active.conversationOpen) {
      try {
        if (document.querySelector(selector)) return true;
      } catch (_) {
        /* A malformed selector must not decide this either way. */
      }
    }
    return false;
  }

  /* Selector chains come from `active`. Ordering and meaning are unchanged from the
   * original hardcoded version: most specific first (attribute values WhatsApp owns and
   * rotates), structural/ARIA last (should only move in a real redesign), so a partial
   * break degrades to a broader match rather than to nothing.
   *
   * Resolution logic below is untouched. Only where the list comes from changed. */
  function currentTargets() {
    return active.targets;
  }

  /**
   * Swap in a new config.
   *
   * Logs `config_source` on EVERY call, including when nothing changes. That is the
   * point: a console paste should say immediately whether the extension is running fresh
   * remote config, a stale cache, or the frozen fallback - without which "the selectors
   * are wrong" and "the config never loaded" look identical.
   */
  function install(cfg, source, meta) {
    if (cfg) {
      const t = cfg.targets || {};
      const usable =
        t.composeBox &&
        Array.isArray(t.composeBox.selectors) &&
        t.composeBox.selectors.length > 0 &&
        Array.isArray(cfg.conversationOpen) &&
        cfg.conversationOpen.length > 0;

      if (usable) {
        active = cfg;
        activeSource = source;
        /* A new config invalidates the per-target latches: a target failing under the old
         * selectors deserves a fresh verdict, and one that was fine may now not be. */
        Object.keys(lastOutcome).forEach((k) => delete lastOutcome[k]);
      } else {
        log('config_rejected_on_apply', { source, ...(meta || {}) }, 'warn');
      }
    }

    log('config_source', {
      source: activeSource,
      version: active.version,
      updated: active.updated,
      compose_selectors: active.targets.composeBox.selectors.length,
      ...(meta || {}),
    }, activeSource === 'remote' ? 'info' : 'warn');

    return activeSource;
  }

  /* ---------------------------------------------------------------------------
   * Failure counters.
   *
   * chrome.storage.local rather than a module-level variable because the useful
   * question is "how long has this been broken", and that outlives a page load. Writes
   * are fire-and-forget and can never reject into a caller: a storage failure must not
   * be able to break DOM resolution, which is the thing that actually matters.
   * ------------------------------------------------------------------------- */

  /* Per-target veto on a matched element, applied by `resolve` for EVERY caller.
   *
   * This lives with the target rather than with the caller on purpose. It used to be
   * passed in by composeBox(), which meant the health check - which calls resolve()
   * directly - did not apply it, and would happily report the search box as a healthy
   * compose box while composeBox() itself rejected the same element. Two answers to one
   * question is worse than either answer. */
  const REJECTORS = {
    /* The broad rungs also match WhatsApp's chat-search box, a role="textbox" outside any
     * footer. Analysing that would mean sending the user's search query to the backend -
     * wrong, and a privacy problem, since a search box is not a draft. */
    composeBox: (element, index) => {
      if (index < 3) return false;            /* specific rungs are trusted as-is */
      try {
        if (element.closest('footer')) return false;
      } catch (_) {
        return true;
      }
      log('compose_box_outside_footer', { matchedIndex: index }, 'warn');
      return true;                             /* skip this rung, keep walking */
    },
  };

  /* One entry per target, holding the last outcome logged or counted.
   *
   * WhatsApp Web mutates continuously - the observer in content.js fires many times a
   * second - and the first version re-logged and re-counted on every tick. That produced
   * dozens of identical warnings per second and turned `selector_failures` into a count
   * of observer callbacks rather than of outages: a number that looked like evidence and
   * measured nothing. A failure is now recorded on the TRANSITION into failure, and a
   * recovery resets the latch. */
  const lastOutcome = Object.create(null);

  /* ---------------------------------------------------------------------------
   * Self-tuning selector order.
   *
   * `lastSuccess[target]` is the index that last resolved. Held in memory for the hot
   * path and mirrored to chrome.storage.local so the hint survives a reload - which
   * matters, because a WhatsApp DOM change persists across reloads and the point is not
   * to re-pay the failed attempts on every one.
   * ------------------------------------------------------------------------- */
  const SUCCESS_STORE_KEY = 'selector_last_success';
  const lastSuccess = Object.create(null);

  /** Attempt order: remembered index first, then the config's own order. */
  function attemptOrder(target, length) {
    const hint = lastSuccess[target];
    const natural = [];
    for (let i = 0; i < length; i += 1) natural.push(i);
    if (typeof hint !== 'number' || hint < 0 || hint >= length || hint === 0) {
      return natural;
    }
    return [hint, ...natural.filter((i) => i !== hint)];
  }

  function rememberSuccess(target, index) {
    if (lastSuccess[target] === index) return;
    lastSuccess[target] = index;
    if (index > 0) {
      log('selector_order_learned', {
        target,
        willTryFirst: index,
        note: 'subsequent resolutions try this index before the configured order',
      });
    }
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.set({ [SUCCESS_STORE_KEY]: { ...lastSuccess } }, () => {
        void (chrome.runtime && chrome.runtime.lastError);
      });
    } catch (_) {
      /* A hint that cannot be persisted is still useful in memory. */
    }
  }

  /** Restore hints from a previous session. Best-effort; failure just means no hint. */
  function restoreSuccessHints() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get([SUCCESS_STORE_KEY], (stored) => {
        void (chrome.runtime && chrome.runtime.lastError);
        const saved = stored && stored[SUCCESS_STORE_KEY];
        if (!saved || typeof saved !== 'object') return;
        Object.keys(saved).forEach((t) => {
          if (typeof saved[t] === 'number') lastSuccess[t] = saved[t];
        });
      });
    } catch (_) {
      /* See above. */
    }
  }

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
   * @param {string} target
   * @param {{record?: boolean}} [options] `record: false` resolves silently - for
   *        pollers and health checks that must not each count as an incident.
   * @returns {{element: Element|null, target: string, matchedSelector: string|null,
   *            matchedIndex: number, attempted: string[]}}
   */
  function resolve(target, options) {
    const record = !options || options.record !== false;
    /* Optional caller-supplied veto on a matched element. Applied inside the chain walk
     * so a rejected match falls through to the next rung instead of ending resolution. */
    const reject = REJECTORS[target] || null;
    const spec = currentTargets()[target];
    const attempted = [];

    if (!spec) {
      log('selector_unknown_target', { target }, 'warn');
      return { element: null, target, matchedSelector: null, matchedIndex: -1, attempted };
    }

    /* Self-tuning order: try whatever worked last time first.
     *
     * After a partial DOM change the config's priority order can be wrong - the first
     * entry no longer matches and the third does. Without this, every resolution pays
     * the failed querySelector calls before reaching the one that works, on every
     * mutation, until someone pushes a reordered config.
     *
     * This changes nothing while healthy: the successful selector is already index 0 and
     * `order` comes back identical. Its value is entirely in the degraded case, which is
     * the case that lasts longest.
     *
     * The remembered index is a HINT, never a filter: the full ordered list is still
     * tried after it, so a stale hint costs one extra query and can never make a
     * resolvable target unresolvable. */
    const order = attemptOrder(target, spec.selectors.length);

    for (const i of order) {
      const selector = spec.selectors[i];
      attempted.push(selector);
      const element = trySelector(selector);
      if (element && reject && reject(element, i)) {
        /* Matched, but the caller says this is the wrong element. Treat it exactly like a
         * miss and keep walking - never let a rejected match end the search. */
        continue;
      }
      if (element) {
        rememberSuccess(target, i);
        if (i > 0 && lastOutcome[target] !== `degraded:${i}`) {
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
        /* Recovery clears the latch, so a genuine second outage is counted again. */
        lastOutcome[target] = i > 0 ? `degraded:${i}` : 'ok';
        return { element, target, matchedSelector: selector, matchedIndex: i, attempted };
      }
    }

    /* Every rung failed. This is the day the file was written for - but log and count it
     * ONCE per transition into failure, not once per observer tick. */
    if (record && lastOutcome[target] !== 'failed') {
      lastOutcome[target] = 'failed';
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
    }

    return { element: null, target, matchedSelector: null, matchedIndex: -1, attempted };
  }

  /** Just the element, for callers that do not care how it was found. */
  function element(target) {
    return resolve(target).element;
  }

  /* The broad rungs of the composeBox chain also match WhatsApp's chat-search box, which
   * is a role="textbox" outside any footer. So a match from rung 3 onward is only
   * accepted if it sits inside a footer - otherwise the extension would quietly analyse
   * the user's search query, which is both wrong and a privacy problem, since a search
   * box is not a draft.
   *
   * REJECTING A MATCH MUST NOT ABANDON THE CHAIN. This previously returned null the
   * moment a late rung matched something outside a footer, which meant the earlier,
   * correct rungs were never tried - `resolve` stops at its first match, so index 0 was
   * unreachable once a broad rung matched first.
   *
   * That was survivable until two other things lined up. A broad
   * `div[role="textbox"][aria-label]` rung was added to the remote config, and the
   * self-tuning order promotes whichever index last matched to the front and PERSISTS it
   * to chrome.storage.local. Once that hint pointed at the broad rung, every resolution
   * matched the search box first, got rejected here, and returned null - so the compose
   * box was never found, no input listener was ever attached, and draft capture went
   * silent. Permanently, and across extension reloads, because the hint outlives them.
   *
   * The fix is to treat a footer-less match as a rung that did not match, and keep going.
   * `resolve` takes a `reject` predicate so the skipping happens inside the chain walk
   * where it belongs, rather than as a post-filter that can only say yes or no to the
   * one answer it was handed.
   */
  function composeBox(options) {
    /* No chat open means no compose box, and that is not a fault. Resolving anyway would
     * log and count a failure on every load before the user clicks a conversation - see
     * `isConversationOpen`. */
    if (!isConversationOpen()) return null;
    /* The footer check lives in REJECTORS so every caller gets it, including the health
     * check. See the comment there for the outage that taught us that. */
    return resolve('composeBox', options).element;
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

  restoreSuccessHints();

  self.SWY.selectors = {
    /* Live getter, not a snapshot: callers that read this at load time must still see an
     * upgraded config when one arrives asynchronously. */
    get TARGETS() {
      return currentTargets();
    },
    get source() {
      return activeSource;
    },
    get version() {
      return active.version;
    },
    FROZEN_CONFIG,
    install,
    attemptOrder,
    lastSuccessHints: () => ({ ...lastSuccess }),
    /* Test seam: drop the learned hints so the untuned attempt order can be observed.
     * Not used in normal operation - a stale hint is self-correcting, costing one extra
     * query and being replaced by the next success. */
    forgetHints: () => Object.keys(lastSuccess).forEach((k) => delete lastSuccess[k]),
    resolve,
    element,
    composeBox,
    isConversationOpen,
    readFailures,
    criticalTargets: () =>
      Object.keys(currentTargets()).filter((name) => currentTargets()[name].critical),
  };
})();
