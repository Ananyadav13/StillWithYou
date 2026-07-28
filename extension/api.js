/* The backend call. Imported by the service worker only — never by a content script.
 *
 * WHY THE FETCH LIVES HERE AND NOT IN content.js
 * ----------------------------------------------
 * This is the Manifest V3-specific answer, and it is not the same as the MV2 one.
 *
 * A `fetch()` from a content script is NOT sent with the extension's origin. Since
 * Chrome 73/85 it carries the HOST PAGE's origin — `https://web.whatsapp.com` — and is
 * subject to ordinary CORS; the extension's `host_permissions` no longer relax it.
 * Making that work would mean adding `https://web.whatsapp.com` to the backend's
 * CORS_ORIGINS, i.e. configuring the API to accept cross-origin requests from a
 * third-party website. That is a genuinely bad thing to leave in a config file, and it
 * would persist long after this proof of concept was forgotten.
 *
 * A `fetch()` from the background service worker runs at the extension's own origin,
 * `host_permissions` grants it cross-origin access, and CORS is not enforced against
 * it. So the content script captures text and posts it here over
 * `chrome.runtime.sendMessage`; this file owns the network, the timeout and the failure
 * handling, and messages the result back.
 *
 * The split has a second benefit worth naming: the content script touches the DOM and
 * no network, and the service worker touches the network and no DOM. Neither half can
 * fail in the other's way.
 *
 * FAILURE POLICY
 * --------------
 * Every failure resolves to `{ok: false, reason}`. Nothing rejects, nothing throws, and
 * nothing is ever shown to the user about it. A WhatsApp Web user who has never heard of
 * this project must not see an error from it — the backend being down is StillWithYou's
 * problem, and the correct user-visible consequence is no banner at all. This is the
 * opposite of the health check's policy, and deliberately so: a broken selector means
 * the extension is silently useless and the user needs to know, whereas an unreachable
 * backend on a local dev machine is the expected state most of the time.
 */

const ENDPOINT = '/analyze-preview';

/* Same 3s and the same reasoning as Phase 4 Step 6 and the backend's
 * `gemini_timeout_seconds`: wide margin over the measured warm latency for this
 * endpoint (44-55ms for a real inference, 10-16ms on a cache hit), short enough that a
 * hung backend cannot leave work outstanding on a page the user is actively using.
 *
 * The margin is not theoretical here. A cold API process pays the model's 8.22s load,
 * and a request that arrives during the warm window blocks on it — measured at 3.50s on
 * the very first call after startup. So the deadline genuinely fires in normal
 * operation, on exactly the request a user is most likely to make first, and the
 * behaviour it produces (no banner, one logged line) is the behaviour that case needs. */
const TIMEOUT_MS = 3000;

/**
 * Analyse one draft.
 *
 * @param {string} apiBase
 * @param {string} content
 * @returns {Promise<{ok: true, analysis: object, elapsedMs: number} |
 *                   {ok: false, reason: string, elapsedMs: number}>}
 */
export async function analyzePreview(apiBase, content) {
  const startedAt = Date.now();

  /* AbortController rather than Promise.race: racing leaves the request in flight, so a
   * backend that is merely slow accumulates one abandoned connection per typing pause.
   * Aborting actually cancels it. */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${apiBase}${ENDPOINT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: controller.signal,
      /* No cookies. There is no session to carry and nothing this endpoint
       * authenticates, so sending credentials would be pure attack surface. */
      credentials: 'omit',
      cache: 'no-store',
    });

    const elapsedMs = Date.now() - startedAt;

    if (!response.ok) {
      /* 404 is the expected answer when PREVIEW_ENABLED=false, and is named rather than
       * lumped into a generic http_error so a disabled endpoint is not mistaken for a
       * broken one while reading logs. */
      return {
        ok: false,
        reason: response.status === 404 ? 'endpoint_absent' : `http_${response.status}`,
        elapsedMs,
      };
    }

    return { ok: true, analysis: await response.json(), elapsedMs };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;

    /* The three cases are distinguished because they mean genuinely different things to
     * whoever is reading the log: the deadline fired, the backend is not listening, or
     * something else went wrong. Collapsing them into "failed" is what makes an
     * extension's logs useless six months later. */
    if (error && error.name === 'AbortError') {
      return { ok: false, reason: 'timeout', elapsedMs };
    }
    if (error instanceof TypeError) {
      return { ok: false, reason: 'unreachable', elapsedMs };
    }
    return {
      ok: false,
      reason: `error:${String((error && error.message) || error).slice(0, 80)}`,
      elapsedMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const TIMEOUTS = { REQUEST_TIMEOUT_MS: TIMEOUT_MS };
