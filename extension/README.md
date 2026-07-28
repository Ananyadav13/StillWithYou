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
| `selectors.js` | The resilience layer — fallback chains, failure counters, never throws |
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
cd fixtures && npm install && node run-evidence.mjs
```

Runs the real source files against a local replica of the compose-box DOM and a real
backend: selector degradation, the deliberate-break test, the debounce, the banner
threshold, overlay non-occlusion, and all three failure modes. 50/50 at time of writing —
output in [`../docs/phase5-evidence.txt`](../docs/phase5-evidence.txt).

**It does not prove the selectors match today's WhatsApp.** The fixture is a copy of a
moving target and goes stale exactly as `selectors.js` does. That is what the health
check is for.
