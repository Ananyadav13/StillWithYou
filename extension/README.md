# StillWithYou — WhatsApp Web extension (proof of concept)

**Not published. Not submitted to the Chrome Web Store. Not distributed.** Local
unpacked extension only, for portfolio and demo purposes. Full scope, risk statement and
evidence: [`../docs/phase5-scope.md`](../docs/phase5-scope.md).

It reads the WhatsApp Web compose box on a typing pause, asks the local backend to score
the draft, and shows a small nudge overlay when `heat_score` crosses 0.35.

## The boundary

> The extension **reads** the compose box's text and **adds** an overlay of its own. It
> performs no other interaction with WhatsApp.

No writing to the compose box. No `preventDefault`, and no `keydown` handler at all. No
listener on the send button. No patching of `fetch`/XHR/WebSocket. No main-world
injection. No reading of the message transcript. If you are about to add any of those,
read the scope doc first — the constraint is the point of the phase, not an obstacle to
it.

## Why it is built the way it is

WhatsApp Web's DOM is unversioned and undocumented, so this **will** break, repeatedly.
Everything here assumes that: selectors return `null` instead of throwing, failures are
counted into `chrome.storage.local` so an outage is diagnosable after the fact, and a
detached extension says so on screen rather than going quiet — because silence looks
exactly like "your message is fine".

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3. `storage` + `host_permissions` for the local API only |
| `config.js` | Every tunable, each with the reasoning next to it |
| `selectors.js` | The resilience layer — fallback chains, failure counters, self-tuning order, never throws. Also holds the FROZEN SNAPSHOT (last-resort selectors) |
| `remote_config.js` / `config_source.js` | Runtime selector config: fetch, validate, cache, 3-tier fallback |
| `../extension-config/selectors.json` | **Source of truth for selectors.** Edit this to fix a DOM change — no code change needed |
| `health_check.js` | Are we still attached? Renders the "couldn't attach" indicator |
| `content.js` | Debounced compose-box read; the only file that touches WhatsApp's DOM |
| `banner.js` / `banner.css` | The nudge overlay, ported from the main app's `NudgeBanner` |
| `background.js` / `api.js` | Service worker owning the network call (see below) |
| `fixtures/` | Headless-Chrome evidence harness and the WhatsApp-DOM replica |

**The fetch lives in the service worker, not the content script.** In Manifest V3 a
content-script `fetch` carries the *host page's* origin, so making it work would mean
adding `https://web.whatsapp.com` to the backend's CORS config. The service worker runs
at the extension's own origin where `host_permissions` grants access and CORS does not
apply. Details in the header of `api.js`.

## Running it

```bash
# 1. backend — wait for `preview_model_ready` in the log before typing anything
docker compose up -d
cd backend && .venv/Scripts/python.exe -m uvicorn app.main:app --port 8000

# 2. chrome://extensions -> Developer mode -> Load unpacked -> select this folder
# 3. open web.whatsapp.com, DevTools console, filter on [StillWithYou]
```

## Evidence harness

```bash
cd fixtures && npm install
node run-evidence.mjs          # 61/61 — behaviour, failure modes, banner
node run-config-evidence.mjs   # 45/45 — remote config, fallback tiers, recovery
node sync-snapshot.mjs         # frozen snapshot vs selectors.json
```

Runs the real source files against a local replica of the compose-box DOM and a real
backend: selector degradation, the deliberate-break test, the "no chat open" case, log
volume under DOM churn, the debounce, the banner threshold, overlay non-occlusion, and
all three failure modes. Output in
[`../docs/phase5-evidence.txt`](../docs/phase5-evidence.txt) and
[`../docs/phase5-config-evidence.txt`](../docs/phase5-config-evidence.txt).

**It does not prove the selectors match today's WhatsApp.** The fixture is a copy of a
moving target and goes stale exactly as the config does. That is what the health check is
for — and, now, what the remote config is for.

## Fixing a broken selector

A WhatsApp DOM change is a **config push, not a code release**:

```bash
# 1. find the new selector - paste into the console on web.whatsapp.com WITH A CHAT OPEN
#    fixtures/diagnose-selectors.js
# 2. edit extension-config/selectors.json, bump `version`
# 3. keep the frozen snapshot in step
cd fixtures && node sync-snapshot.mjs --fix
# 4. commit. Live in ~5 min (GitHub raw CDN). Every installed extension picks it up
#    on its next load - no reload, no re-install.
node run-config-evidence.mjs   # 45/45
```

`config_source` in the console says which tier is active (`remote` / `cache` /
`hardcoded`) on every load, so "the selectors are wrong" and "the config never loaded"
are never confused. Design and threat model:
[`../docs/phase5-remote-config.md`](../docs/phase5-remote-config.md).
