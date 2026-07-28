/* Background service worker.
 *
 * Its whole job is to own the network call, because a content script cannot make it
 * without dragging the host page's origin into the backend's CORS config — see the
 * comment at the top of api.js for the Manifest V3 specifics.
 *
 * It holds no state worth losing. MV3 service workers are terminated aggressively when
 * idle and restarted on the next message, so anything cached here would evaporate at
 * unpredictable times; the analysis cache that matters lives in Redis behind the
 * backend, shared with the worker process, and survives all of this.
 */

import { analyzePreview } from './api.js';
import { loadConfig } from './config_source.js';

const API_BASE = 'http://127.0.0.1:8000';
const MARKER = '[StillWithYou:sw]';

function log(event, fields = {}, level = 'info') {
  try {
    const method = level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info';
    // eslint-disable-next-line no-console
    console[method](`${MARKER} ${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}`);
  } catch (_) {
    /* A logger that can throw is worse than no logger. */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  log('installed', { api_base: API_BASE });
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  /* Selector config. Answered on every content-script load, and deliberately NOT
   * awaited by the content script — it has already booted on its frozen snapshot by the
   * time this resolves, and upgrades in place if something better arrives. See
   * remote_config.js on why the load sequence must never wait for the network. */
  if (request && request.type === 'SWY_CONFIG') {
    loadConfig({ force: Boolean(request.force) })
      .then((result) => {
        log(
          'config_fetch',
          {
            source: result.source,
            version: result.version,
            reason: result.reason,
            cached_at: result.cachedAt,
            elapsed_ms: result.elapsedMs,
          },
          result.source === 'remote' ? 'info' : 'warn',
        );
        sendResponse(result);
      })
      .catch((error) => {
        /* loadConfig does not reject by contract. If a future edit breaks that, the
         * content script must still get an answer rather than waiting forever on a
         * channel that never closes. */
        log('config_fetch_threw', { error: String((error && error.message) || error).slice(0, 200) }, 'error');
        sendResponse({ source: 'unavailable', config: null, reason: 'exception' });
      });
    return true;
  }

  if (!request || request.type !== 'SWY_ANALYZE') return false;

  const content = typeof request.content === 'string' ? request.content : '';
  if (!content.trim()) {
    sendResponse({ ok: false, reason: 'empty' });
    return false;
  }

  analyzePreview(API_BASE, content)
    .then((result) => {
      log(
        'analyze',
        {
          ok: result.ok,
          reason: result.ok ? undefined : result.reason,
          elapsed_ms: result.elapsedMs,
          chars: content.length,
          /* The draft itself is never logged here. The content script logs it during
           * Step 3 verification only; in normal operation nothing writes a user's
           * unsent message to a console. */
          mood: result.ok ? result.analysis.mood : undefined,
          heat_score: result.ok ? result.analysis.heat_score : undefined,
        },
        result.ok ? 'info' : 'warn',
      );
      sendResponse(result);
    })
    .catch((error) => {
      /* analyzePreview does not reject by contract; this is here so that a future edit
       * which breaks that contract degrades to "no banner" rather than to a dangling
       * sendResponse and a content script waiting forever. */
      log('analyze_threw', { error: String((error && error.message) || error).slice(0, 200) }, 'error');
      sendResponse({ ok: false, reason: 'exception' });
    });

  /* Keeps the message channel open for the async sendResponse above. Without this the
   * channel closes immediately and every reply is silently dropped. */
  return true;
});
