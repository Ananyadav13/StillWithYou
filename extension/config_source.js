/* Fetching, validating and caching the remote selector config.
 *
 * Imported by the service worker only, for the same Manifest V3 reason as api.js: a
 * content-script fetch carries the host page's origin, while a service-worker fetch runs
 * at the extension's own origin where `host_permissions` grants access. Keeping both
 * network calls on the same side of the boundary also means the content script does no
 * networking at all, which is easy to state and easy to check.
 *
 * THREE SOURCES, IN PREFERENCE ORDER
 *   remote     freshly fetched from GitHub - the source of truth
 *   cache      last-known-good in chrome.storage.local - survives being offline
 *   hardcoded  frozen snapshot in selectors.js - first run with no network
 *
 * The caller always gets an answer. There is no failure path that returns nothing,
 * because "no selectors" is indistinguishable from "the DOM changed" at the point of
 * use, and the two need very different handling.
 *
 * Full rationale, alternatives and threat model: docs/phase5-remote-config.md.
 */

const CONFIG_URL =
  'https://raw.githubusercontent.com/Ananyadav13/StillWithYou/main/extension-config/selectors.json';

const CACHE_KEY = 'remote_selector_config';

/* Deliberately shorter than the 3s analysis deadline. This runs while WhatsApp Web is
 * loading, and unlike an analysis call there is nothing waiting on the result — the
 * extension has already booted on the frozen snapshot by the time this resolves. A long
 * timeout here would buy nothing and hold a connection open on someone's browser during
 * page load. */
const FETCH_TIMEOUT_MS = 2500;

/**
 * Is this a config we are willing to run?
 *
 * Runs before anything is cached, so a malformed or hostile response cannot poison the
 * last-known-good entry — which would otherwise turn one bad push into a persistent
 * failure surviving every later good one.
 *
 * Checks shape only. It cannot check that the selectors still *match* WhatsApp; that is
 * what the health check is for, and no amount of validation here substitutes for it.
 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object') return 'not_an_object';

  const targets = config.targets;
  if (!targets || typeof targets !== 'object') return 'missing_targets';

  for (const name of ['composeBox', 'sendButton']) {
    const spec = targets[name];
    if (!spec || typeof spec !== 'object') return `missing_target:${name}`;
    if (!Array.isArray(spec.selectors) || spec.selectors.length === 0) {
      return `empty_selectors:${name}`;
    }
    if (!spec.selectors.every((s) => typeof s === 'string' && s.trim().length > 0)) {
      return `non_string_selector:${name}`;
    }
  }

  /* conversationOpen decides "no chat open" from "the DOM moved". A config without it
   * would make the extension report a splash screen as an outage - the crying-wolf
   * failure the health check exists to avoid. */
  if (!Array.isArray(config.conversationOpen) || config.conversationOpen.length === 0) {
    return 'missing_conversation_open';
  }

  return null;
}

/** Strip everything the extension does not use, so nothing unexpected reaches storage. */
function normalise(config) {
  const targets = {};
  for (const name of Object.keys(config.targets)) {
    const spec = config.targets[name];
    targets[name] = {
      critical: Boolean(spec.critical),
      description: typeof spec.description === 'string' ? spec.description : name,
      selectors: spec.selectors.filter((s) => typeof s === 'string'),
    };
  }
  return {
    version: Number(config.version) || 0,
    updated: typeof config.updated === 'string' ? config.updated : null,
    targets,
    conversationOpen: config.conversationOpen.filter((s) => typeof s === 'string'),
  };
}

function readCache() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([CACHE_KEY], (stored) => {
        void chrome.runtime.lastError;
        resolve((stored && stored[CACHE_KEY]) || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function writeCache(entry) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [CACHE_KEY]: entry }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (_) {
      resolve();
    }
  });
}

/**
 * Best config available right now.
 *
 * @returns {Promise<{source: 'remote'|'cache'|'unavailable', config: object|null,
 *                    version: number|null, reason?: string, elapsedMs: number,
 *                    cachedAt?: string}>}
 *
 * `unavailable` means the caller should use its own frozen snapshot. This module never
 * returns the snapshot itself: it ships inside selectors.js so that the extension has
 * working selectors before any async work happens at all.
 */
export async function loadConfig({ force = false } = {}) {
  const startedAt = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(CONFIG_URL, {
      signal: controller.signal,
      credentials: 'omit',
      /* GitHub's raw CDN caches ~5 minutes. `no-cache` revalidates rather than serving
       * whatever the browser happens to hold, so a pushed fix is not additionally
       * delayed by a local cache on top of the CDN's. `force` bypasses entirely, for
       * the manual "I just pushed a fix" path. */
      cache: force ? 'reload' : 'no-cache',
    });

    if (!response.ok) throw new Error(`http_${response.status}`);

    const parsed = await response.json();
    const invalid = validateConfig(parsed);
    if (invalid) {
      /* A reachable but malformed config is NOT cached, and is treated as a fetch
       * failure so the caller falls back to last-known-good. A bad push should cost
       * nothing beyond the config staying at its previous value. */
      return {
        source: 'unavailable',
        config: null,
        version: null,
        reason: `invalid:${invalid}`,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const config = normalise(parsed);
    await writeCache({ config, cachedAt: new Date().toISOString(), url: CONFIG_URL });

    return {
      source: 'remote',
      config,
      version: config.version,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    const reason =
      error && error.name === 'AbortError'
        ? 'timeout'
        : `error:${String((error && error.message) || error).slice(0, 60)}`;

    const cached = await readCache();
    if (cached && cached.config && !validateConfig(cached.config)) {
      return {
        source: 'cache',
        config: cached.config,
        version: cached.config.version,
        cachedAt: cached.cachedAt,
        reason,
        elapsedMs: Date.now() - startedAt,
      };
    }

    return {
      source: 'unavailable',
      config: null,
      version: null,
      reason,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const CONFIG = { CONFIG_URL, CACHE_KEY, FETCH_TIMEOUT_MS };
