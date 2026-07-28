/* The nudge banner overlay.
 *
 * A port of frontend/src/components/NudgeBanner.tsx: same copy, same two tones, same
 * hedged wording, same dismissal semantics. Written as plain DOM rather than React
 * because the extension has no build step, and the palette lives in banner.css so the
 * port stays checkable against the original by diff.
 *
 * POSITIONING — WHY AN OVERLAY AND NOT AN INSERTION
 * -------------------------------------------------
 * The banner is appended to `document.body` in a `position: fixed` container and placed
 * from the compose box's `getBoundingClientRect()`. It is never inserted into
 * WhatsApp's own tree.
 *
 * That is the difference between "renders near the compose box" and "modifies
 * WhatsApp's layout", and it is the read-only boundary made concrete:
 *
 *   - it cannot shift, reflow or resize anything WhatsApp rendered,
 *   - it cannot be caught by WhatsApp's event delegation, which walks their tree,
 *   - if WhatsApp's DOM changes underneath it, the worst case is a banner in the wrong
 *     place — not a broken chat window.
 *
 * The cost is that a fixed overlay does not follow a scrolling or resizing page for
 * free, so position is recomputed on scroll and resize while the banner is up. That is
 * a deliberate trade: cheap recomputation in exchange for never touching their layout.
 */

self.SWY = self.SWY || {};

(function initBanner() {
  const { config, log } = self.SWY;
  const BANNER_ID = 'swy-nudge-banner';

  /* Dismissal is keyed on the analysed text rather than on nothing, so dismissing a
   * banner suppresses it for THAT draft only. A session-wide dismissal would recreate
   * the exact failure this phase is built around: silence that the user reads as calm.
   * Editing the message brings the nudge back, which is correct — it is a different
   * message now. */
  let dismissedFor = null;
  let repositionBound = false;

  function remove() {
    try {
      const existing = document.getElementById(BANNER_ID);
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    } catch (_) {
      /* Never throws into the host page. */
    }
  }

  /** Place the banner just above the compose box, clamped to the viewport. */
  function position(node) {
    try {
      const anchor = self.SWY.selectors.composeBox();
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const height = node.offsetHeight || 64;
      const GAP = 10;

      /* Above the compose box when there is room, below it when there is not. Never
       * over it: covering the box the user is typing into would be its own small
       * usability disaster. */
      let top = rect.top - height - GAP;
      if (top < 8) top = Math.min(rect.bottom + GAP, window.innerHeight - height - 8);

      const left = Math.max(8, Math.min(rect.left, window.innerWidth - node.offsetWidth - 8));

      node.style.top = `${Math.round(top)}px`;
      node.style.left = `${Math.round(left)}px`;
    } catch (error) {
      log('banner_position_failed', { error: String(error && error.message).slice(0, 160) }, 'warn');
    }
  }

  function bindReposition(node) {
    if (repositionBound) return;
    const handler = () => position(node);
    /* Passive: this must not be able to slow WhatsApp's own scrolling. Listeners are on
     * `window`, not on any WhatsApp element. */
    window.addEventListener('scroll', handler, { passive: true, capture: true });
    window.addEventListener('resize', handler, { passive: true });
    repositionBound = true;
  }

  /**
   * Show or hide the banner for one analysis result.
   *
   * Mirrors NudgeBanner.tsx's two rules exactly:
   *   1. never render without backing data — a missing heat_score is not a low one;
   *   2. hedge in the copy, not only in the colour.
   *
   * @param {string} text     the draft this result describes
   * @param {object|null} analysis  the /analyze-preview body, or null to clear
   */
  function render(text, analysis) {
    try {
      if (!analysis || typeof analysis.heat_score !== 'number') {
        remove();
        return false;
      }

      if (analysis.heat_score < config.HEAT_THRESHOLD) {
        remove();
        return false;
      }

      if (dismissedFor === text) return false;

      remove();

      const tone = analysis.mood === 'angry' ? 'angry' : 'frustrated';
      const body =
        analysis.rewrite_suggestion ||
        'This may land harder than you intend. Worth rereading before you send it.';

      const node = document.createElement('div');
      node.id = BANNER_ID;
      node.className = 'swy-banner';
      node.setAttribute('data-tone', tone);
      /* polite, never assertive: this interrupts a sentence someone is mid-way through
       * thinking about, and it is not urgent enough to cut across a screen reader. */
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');

      const mark = document.createElement('span');
      mark.className = 'swy-banner__mark';
      mark.setAttribute('aria-hidden', 'true');

      const bodyWrap = document.createElement('div');
      bodyWrap.className = 'swy-banner__body';

      const label = document.createElement('span');
      label.className = 'swy-banner__label';
      label.textContent = 'Worth a pause';

      const message = document.createElement('span');
      message.className = 'swy-banner__text';
      /* textContent, never innerHTML. The body can include the user's own wording via
       * the analyzer's suggestion, and this is somebody else's page. */
      message.textContent = body;

      const meta = document.createElement('span');
      meta.className = 'swy-banner__meta';
      /* "reads as", never "is". The heat score is shown as the intensity signal it is,
       * not as a confidence — the pipeline emits no per-message confidence, so any
       * number presented as one would be invented. */
      meta.textContent = `Reads as ${tone} · heat ${analysis.heat_score.toFixed(2)}`;

      const dismiss = document.createElement('button');
      dismiss.className = 'swy-banner__dismiss';
      dismiss.type = 'button';
      dismiss.textContent = 'Dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss this nudge');
      dismiss.addEventListener('click', () => {
        dismissedFor = text;
        remove();
        log('banner_dismissed', { chars: text.length });
      });

      bodyWrap.appendChild(label);
      bodyWrap.appendChild(message);
      bodyWrap.appendChild(meta);
      node.appendChild(mark);
      node.appendChild(bodyWrap);
      node.appendChild(dismiss);
      document.body.appendChild(node);

      position(node);
      bindReposition(node);

      log('banner_shown', {
        tone,
        mood: analysis.mood,
        heat_score: analysis.heat_score,
        threshold: config.HEAT_THRESHOLD,
        source: analysis.source,
        language: analysis.language,
      });

      return true;
    } catch (error) {
      /* A banner that throws is strictly worse than no banner. */
      log('banner_render_failed', { error: String(error && error.message).slice(0, 200) }, 'error');
      remove();
      return false;
    }
  }

  self.SWY.banner = { render, remove, BANNER_ID, resetDismissal: () => { dismissedFor = null; } };
})();
