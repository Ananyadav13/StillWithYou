/* Content-script side of the remote selector config.
 *
 * Asks the service worker for the best config it can get, and installs it. The fetching,
 * validating and caching all happen in `config_source.js` on the service-worker side —
 * see api.js's header for why every network call lives there.
 *
 * THE LOAD SEQUENCE NEVER WAITS FOR THIS
 * --------------------------------------
 * `selectors.js` boots with its frozen snapshot already active, synchronously, before
 * this file runs. The extension attaches and works immediately. When a better config
 * arrives — typically 50-400ms later, or never if offline — it is swapped in and the
 * health check re-runs.
 *
 * That ordering is deliberate and is a hard constraint, not a nicety. Awaiting the
 * network before attaching would put a third-party HTTP request in the critical path of
 * WhatsApp Web's own page load, on every single page load, to save a few hundred
 * milliseconds of running slightly older selectors. The failure mode of that trade is
 * that a slow GitHub makes WhatsApp feel slow, which is exactly the thing this whole
 * phase is organised around never doing.
 *
 * The cost of the trade is a brief window where the frozen snapshot is active even
 * though a newer config exists. That is harmless: the snapshot is by definition the last
 * known-good set, and the worst case is that a just-pushed fix takes effect a few
 * hundred milliseconds into the page rather than at millisecond zero.
 */

self.SWY = self.SWY || {};

(function initRemoteConfig() {
  const { log } = self.SWY;

  /* Called after a config swap so the extension re-evaluates against the new selectors
   * rather than waiting for the next DOM mutation to notice. Set by content.js. */
  let onInstalled = null;

  /**
   * Ask the service worker for config and install whatever comes back.
   *
   * Never rejects. A failure here must leave the extension running on the frozen
   * snapshot, which is a working state — not a broken one.
   *
   * @param {{force?: boolean}} [options] `force` bypasses the browser cache, for the
   *        "I just pushed a selector fix and want it now" path.
   */
  function refresh(options) {
    return new Promise((resolve) => {
      let settled = false;

      /* The service worker holds its own 2.5s fetch deadline. This guard covers the
       * case where the WORKER never answers at all — a terminated MV3 service worker
       * that fails to wake, or an extension reload that drops the channel. Without it
       * the promise would never settle. */
      const guard = setTimeout(() => {
        if (settled) return;
        settled = true;
        log('config_no_response', { after_ms: 4000 }, 'warn');
        /* Still log which source is active, so the console always answers the question
         * "what selectors am I running?" even on this path. */
        self.SWY.selectors.install(null, 'hardcoded', { reason: 'worker_no_response' });
        resolve('hardcoded');
      }, 4000);

      try {
        chrome.runtime.sendMessage(
          { type: 'SWY_CONFIG', force: Boolean(options && options.force) },
          (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(guard);

            if (chrome.runtime && chrome.runtime.lastError) {
              log('config_channel_closed', {
                error: String(chrome.runtime.lastError.message).slice(0, 160),
              }, 'warn');
              resolve(self.SWY.selectors.install(null, 'hardcoded', { reason: 'channel_closed' }));
              return;
            }

            if (!result || result.source === 'unavailable' || !result.config) {
              /* Neither remote nor cache. The frozen snapshot stays active — this is
               * the third tier, and it is a working state. */
              resolve(
                self.SWY.selectors.install(null, 'hardcoded', {
                  reason: (result && result.reason) || 'no_result',
                  elapsed_ms: result && result.elapsedMs,
                }),
              );
              return;
            }

            const source = self.SWY.selectors.install(result.config, result.source, {
              reason: result.reason,
              cached_at: result.cachedAt,
              elapsed_ms: result.elapsedMs,
            });

            try {
              if (onInstalled) onInstalled(source);
            } catch (_) {
              /* A re-check that throws must not break config loading. */
            }

            resolve(source);
          },
        );
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        /* Thrown when the extension context has been invalidated — reloaded while this
         * page stayed open. Nothing to do but stay on the snapshot. */
        log('config_request_failed', {
          error: String((error && error.message) || error).slice(0, 160),
        }, 'warn');
        resolve(self.SWY.selectors.install(null, 'hardcoded', { reason: 'send_failed' }));
      }
    });
  }

  self.SWY.remoteConfig = {
    refresh,
    onInstalled: (callback) => {
      onInstalled = callback;
    },
  };
})();
