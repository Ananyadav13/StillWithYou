# Phase 5 — scope: a WhatsApp Web browser extension, as a proof of concept

**Last updated:** 2026-07-28
**Status:** proof of concept / roadmap item. Not a product, not published, not distributed.

Phase 5 puts the existing analysis pipeline behind a Manifest V3 Chrome extension that
watches the WhatsApp Web compose box and shows a nudge banner when a message reads as
heated. The roadmap in [`project-overview.md`](project-overview.md) §15 lists "a browser
extension, still deliberately untouched" as a later phase; this is that phase, taken up
explicitly as a **proof of concept rather than a feature**.

The interesting engineering here is not the feature. It is that the extension depends on
the internal DOM of a third-party application that owes it nothing. That dependency is
the phase's actual subject, and how the extension behaves when the dependency breaks is
what Steps 2 and 6 exist to demonstrate.

---

## In scope

- **Manifest V3 content script** on `https://web.whatsapp.com/*`, with the narrowest
  permissions that work: `storage` (for the selector-failure counters), and
  `host_permissions` for the local backend only. No `tabs`, no `activeTab`, no
  `<all_urls>`, no `scripting`.
- **Reading the compose box's current text** — the message the user is typing right now,
  before it is sent.
- **Calling the existing backend's analysis path** for that text, debounced (~1.5s idle
  pause). See "Debounce" below, which corrects a premise in the brief.
- **Rendering a nudge banner overlay** near the compose box when `heat_score` crosses the
  threshold set out below. Dismissible, same "pause and look at this" framing as the main
  app's product thesis.

## Out of scope

- **Sending, rewriting, auto-correcting, or modifying any message.** The extension never
  writes to the compose box.
- **Intercepting, delaying, blocking or wrapping WhatsApp's send.** No listener on the
  send button, no `keydown` handler on Enter that can `preventDefault`, no patching of
  `XMLHttpRequest`, `fetch`, or `WebSocket`.
- **Reading message history.** Only the currently-being-typed text in the compose box.
  Nothing in the conversation transcript is read, stored, or transmitted — not the other
  person's messages, not the user's own sent messages, not contact names.
- **Any UI beyond the nudge banner.** Specifically **no avatar in the extension for this
  phase.** Phase 4's avatar stays in the main app.
- **Persisting anything.** No message row is written for extension traffic — see
  "`POST /analyze-preview`" below.
- **Publishing.** Local unpacked extension only. Not submitted to the Chrome Web Store,
  not packaged for distribution, not shared. Loading it requires developer mode and a
  local checkout, which is the intended and only distribution path.

---

## Risk statement: this extension will break, and that is expected

**WhatsApp Web's DOM structure is unversioned, undocumented, and can change without
notice.** There is no public API, no stable contract, no deprecation window, and no
announcement when it changes. The class names are build-generated and opaque. The compose
box is a `contenteditable` div identified by attributes that exist for WhatsApp's own
purposes and can be renamed in any deploy, including one that ships while a user has the
tab open.

This is not a caveat appended to the end of the document. It is the central fact about
the integration, and it has three consequences that shape the design:

1. **The extension will periodically stop working.** Not "may" — will. The expected
   failure rate of an unversioned DOM dependency over any long period is 100%. Anything
   built on it must treat breakage as a normal operating state rather than an exception.

2. **Therefore it must fail loudly to its own user and silently to WhatsApp.** A broken
   selector must produce a visible signal that the extension has detached (so the user
   knows they are not being watched over, rather than assuming a quiet message is a calm
   one), a structured log, and a persisted counter — while producing **nothing at all**
   in WhatsApp's own interface. The two audiences get opposite treatment on purpose.

3. **Therefore it must never fail destructively.** Every DOM access is wrapped so that no
   uncaught error escapes into the host page's context, every selector returns `null`
   rather than throwing, and no code path can leave WhatsApp in a state it did not
   produce itself. A broken StillWithYou must be indistinguishable, from WhatsApp's side,
   from StillWithYou not being installed.

The failure the design most wants to avoid is the quiet one: an extension that silently
stops attaching, shows no banner, and is read by the user as "this message is fine."
**Absence of a warning must never be mistakable for a verdict of calm.** That is the
reasoning behind Step 2's health check being a visible indicator rather than a log line.

---

## The read-only boundary, stated as a rule

> The extension **reads** the compose box's text content and **adds** an overlay element
> of its own. It performs no other interaction with WhatsApp Web. It does not write to,
> modify, remove, reorder, restyle, or attach behaviour to any element WhatsApp created,
> and it does not intercept any event WhatsApp handles.

Concretely, this rules out:

| Not permitted | Why it is named explicitly |
|---|---|
| Setting `.textContent` / `.innerHTML` on the compose box | The obvious next feature ("apply the rewrite") and the exact line this phase does not cross |
| `preventDefault()` on Enter, or any capture-phase key handler | Would make a bug in the extension able to eat a user's send |
| Any listener on the send button | Step 2 resolves `sendButton` for the **health check only** — to detect that the DOM changed. Nothing is ever bound to it |
| Patching `fetch`/`XHR`/`WebSocket`, or injecting into the page's main world | Content script stays in its isolated world; WhatsApp's own network layer is never touched |
| Mutating WhatsApp's layout, or inserting into WhatsApp's own containers | The banner is a fixed-position overlay in its own container, positioned *relative to* the compose box's bounding rect, not injected *into* WhatsApp's tree |

Two of these deserve their own note.

**`sendButton` is resolved but never bound.** It exists in the selector config as a second
canary. If the compose box still resolves but the send button does not, the DOM has
changed in a way that has not yet broken text capture but probably will — one selector
failing is a stronger signal than either alone. This is the only reason it is there, and
the constraint is recorded next to it in `selectors.js` because that file is where someone
would later add a click handler without reading this document.

**The banner is an overlay, not an insertion.** It is appended to `document.body` in a
container with `position: fixed`, positioned from the compose box's
`getBoundingClientRect()`, and `pointer-events` are enabled only on the banner itself and
its dismiss control. It therefore cannot shift WhatsApp's layout, cannot be caught by
WhatsApp's own event delegation, and cannot cause a reflow inside WhatsApp's tree. If
WhatsApp's DOM changes underneath it, the worst outcome is a banner in the wrong place —
not a broken chat window.

---

## Three premises in the brief that the repository contradicts

Phase 4 opened by discovering that its plan rested on Framer Motion already being a
dependency, which it was not. The same check was run first this time. Three items:

### 1. There is no `NudgeBanner` component to reuse

The brief asks for "the same visual language as the main app's NudgeBanner." No such
component exists. `frontend/src/components/` contains exactly `ChatWindow.tsx`,
`MessageBubble.tsx`, `MessageInput.tsx` and `Avatar/`. `heat_score` is fetched into
frontend state in [`useChat.ts:53`](../frontend/src/hooks/useChat.ts) and then rendered
nowhere — which §14 of the overview already records as a known limitation.

**So this phase's banner is the first thing in the entire project to put `heat_score` on
a screen.** That is a meaningfully different task from porting an existing design, and it
carries a consequence worth stating: a proof-of-concept extension should not be where a
core product decision gets made by default. The banner therefore borrows its visual
language from what does exist — the Avatar's palette and restraint conventions, and the
main app's Tailwind tokens, hand-written as plain CSS since the extension has no build
step — and the design of a real in-app nudge banner remains open work for the main app
rather than something Phase 5 quietly settles.

### 2. The main app does not debounce; it is send-only

The brief says to debounce "the same way the main app already does (~1.5s pause or on
Enter/send-click) … same reasoning as the core app." The main app does not do this. The
comment on `sendMessage` in [`useChat.ts`](../frontend/src/hooks/useChat.ts) argues
against it directly:

> Debouncing a per-keystroke call would still send one request per pause; sending only on
> submit sends exactly one request per message, which is the smallest number that can
> possibly work. […] A 200-character message […] with a 400ms debounce, roughly 15-30
> requests. Here it is 1.

Phase 2 Step 4 measured this: **0 backend requests in a 20s typing window, 1 on send.**

**The extension cannot copy that design, because copying it would violate this phase's
own boundary.** "Analyse on send" requires knowing when the user sends, which requires a
listener on the send button or on Enter — exactly what the read-only rule forbids. The
constraint that keeps the extension safe is the same constraint that forces it into the
more expensive request pattern.

So a ~1.5s idle debounce is used, and it is **a deliberate departure from the main app,
not an imitation of it.** It sends strictly more requests than the main app for the same
message — the trade is accepted because the alternative is either touching WhatsApp's
send path or calling per keystroke. Two things make the cost tolerable here that were not
true in Phase 2: the active analyzer is `multilingual_local` at a measured **40ms median**
rather than Gemini at ~1400ms, and `POST /analyze-preview` writes nothing, so the extra
calls cost CPU on a local machine rather than rows in a database and jobs in a queue.

The honest summary: the extension is a **worse citizen** of the backend than the main app
is, by roughly one request per typing pause, and it is worth recording that plainly rather
than citing a "same reasoning" that points the other way.

### 3. No `heat_score` threshold exists anywhere in the project to inherit

`heat_score` has never been thresholded, because it has never been displayed. Phase 5
needs a number, and picking one has a documented trap attached: Phase 3 explicitly
**rejected** tuning the `frustrated`/`angry` thresholds against the 45-message corpus,
because "it would produce a fit reported as a measurement" (overview §14).

The same discipline applies here, so the corpus was used to **bound the range, not to
select the value.** Every one of the 45 fixtures was scored (real run, `multilingual_local`,
lexicon on):

| expected mood | n | min | median | max |
|---|---|---|---|---|
| calm | 9 | 0.00 | 0.09 | 0.22 |
| neutral | 9 | 0.02 | 0.16 | 0.22 |
| frustrated | 12 | 0.22 | 0.42 | 0.61 |
| angry | 15 | 0.12 | 0.37 | 0.77 |

Sweeping the threshold, counting a fixture labelled `frustrated` or `angry` as one that
should fire (n=27) and `calm`/`neutral` as one that should not (n=18):

| threshold | banners shown | correctly fired | wrongly fired | recall |
|---|---|---|---|---|
| 0.20 | 29 | 26/27 | **3/18** | 0.96 |
| 0.23 | 24 | 24/27 | 0/18 | 0.89 |
| 0.25 | 22 | 22/27 | 0/18 | 0.81 |
| 0.30 | 17 | 17/27 | 0/18 | 0.63 |
| **0.35** | **15** | **15/27** | **0/18** | **0.56** |
| 0.40 | 13 | 13/27 | 0/18 | 0.48 |
| 0.50 | 7 | 7/27 | 0/18 | 0.26 |

**The chosen threshold is `heat_score >= 0.35`.**

The reasoning, in the order it actually matters:

- **0.23 is the fitted optimum and is deliberately not used.** It is the best number on
  this table — perfect precision at 0.89 recall — and it sits exactly `0.01` above the
  highest-scoring calm fixture. A threshold whose margin is one fixture is a fit, not a
  measurement. It would very likely not survive contact with a 46th message.
- **The choice is insensitive across 0.23–0.50, which is the useful finding.** False
  positives are zero at every threshold in that band; the only thing moving is recall. So
  the decision is not "where is the boundary" but "how much under-warning is acceptable",
  which is a product judgement rather than a fitted parameter.
- **0.35 is chosen to under-warn.** At 0.35 the banner fires on a little over half the
  genuinely heated messages and none of the calm ones. That direction is deliberate: this
  overlay appears on top of someone else's application, unprompted, while they are
  mid-conversation. A false positive there costs more than a missed warning does — it is
  an interruption the user did not ask for, attached to a message that was fine, in a
  context where the product has no standing. Missing a heated message leaves the user
  exactly where they would be without the extension installed.
- **It is the same instinct as Phase 4's restraint rule**, applied to a different
  quantity: where the pipeline is least reliable, the interface should be least emphatic.
  `angry` fixtures scatter from 0.12 to 0.77, which is the `angry` 6/15 weakness showing
  up in the heat signal too — three genuinely angry messages score below every threshold
  on the table.

**Stated limitations of this number**, so it is not read as stronger than it is: it is
validated against the same 45 self-authored messages that Phase 3 already warns are a
small corpus with wide per-category confidence intervals; it is *not* held-out; and the
zero-false-positive column across the whole band is a property of a corpus whose calm
messages are unambiguously calm, which real typing will not be. The threshold lives in
one named constant in `extension/config.js` with this paragraph beside it.

---

## `POST /analyze-preview` — a new read-only endpoint

The brief asks whether `POST /messages` is the right target. It is not, for a reason
stronger than efficiency: **it persists.** Every debounced pause would write a `messages`
row and enqueue an ARQ job, so a user typing one WhatsApp message would leave several
partial drafts of it permanently in the database. That is wrong on privacy grounds before
it is wrong on load grounds — the extension has no business storing fragments of a
conversation happening in someone else's app.

So Phase 5 adds `POST /analyze-preview`: same `detect_language` → cache → analyzer path,
returning the same `AnalysisResult` shape, **writing no row and enqueuing no job.**

This endpoint runs the analysis **synchronously in the request path**, which is the exact
thing the whole architecture forbids for `POST /messages`. That is a deliberate exception
and it needs its justification recorded next to it, because it is the one place in the
project where the central rule is broken on purpose:

- The rule exists because the request path could not depend on Gemini's tail latency
  (1410ms median, 3.2s and 30s observed). The active analyzer is `multilingual_local` at
  a **40ms median, 49.4ms p95** — three orders of magnitude away from the problem the rule
  was written for. **Gemini is never called from this endpoint at all**, regardless of
  `GEMINI_ENABLED`; if that flag is ever flipped back on, this endpoint must not start
  putting a 1.4s dependency in a synchronous path.
- Nothing is persisted, so the asynchronous design's core guarantee — a message survives
  even if analysis fails — has nothing to protect. There is no message. A failed preview
  loses a banner, and a banner is not a user's words.
- The caller has a hard 3s client-side deadline (Step 6), so a slow response is bounded
  at the client regardless of what the server does.
- The first call in a cold API process pays the model's **8.22s load**, because the model
  currently lives only in the worker process. This is a real cost of the endpoint and is
  handled by warming on startup rather than being discovered by a user; the ~1.1GB
  resident memory it adds to the API process is noted here as the endpoint's actual price.

### CORS, and why the fetch does not live in the content script

The brief flags that the backend's `CORS_ORIGINS` allows only `http://localhost:5173`, and
asks for the MV3-specific answer rather than an assumption. The MV3-specific answer is
that **the content script is the wrong place to make the request**:

- A `fetch()` from a content script is *not* sent with the extension's origin. Since
  Chrome 73/85 the request carries the **host page's** origin (`https://web.whatsapp.com`)
  and is subject to normal CORS; the extension's `host_permissions` no longer relax it.
  Making that work would mean adding `https://web.whatsapp.com` to `CORS_ORIGINS` — i.e.
  configuring the backend to accept cross-origin requests from a third-party site, which
  is a genuinely bad thing to leave in a config file.
- A `fetch()` from the **background service worker** is the supported path. It runs at the
  extension's own origin, `host_permissions` grants it cross-origin access, and CORS is
  not enforced against it.

So: the content script captures text and posts it to the service worker over
`chrome.runtime.sendMessage`; the service worker owns the network call, the timeout, and
the failure handling, and messages the result back. `host_permissions` is
`http://127.0.0.1:8000/*` only — `127.0.0.1` rather than `localhost` also because
`localhost` costs ~2s per request on this machine's IPv6-first resolution, already
recorded in the gotchas list.

This also keeps the boundary tidy: the content script touches the DOM and no network; the
service worker touches the network and no DOM.

**This is a design decision, not yet a verified one.** Step 4's evidence is what confirms
it against a real browser, and if the observed request contradicts any of the above, the
correction goes here rather than the plan being quietly retro-fitted.

---

## Failure modes

The scenarios were written down before the code that handles them, per the Phase 2
convention. All three are now verified, by `extension/fixtures/run-evidence.mjs` against
the real extension sources — **50/50 checks pass**, full output in
[`phase5-evidence.txt`](phase5-evidence.txt).

What that harness is and is not is stated in "Evidence status" below, and it matters:
the DOM is a local fixture, so these results prove the extension's *own* handling is
correct. They do not prove the selectors match today's WhatsApp.

### 1. WhatsApp changes the compose box's DOM structure

**Handled by:** the fallback chain and failure recording in `selectors.js`, and the
visible indicator in `health_check.js`.
**Verified by:** Step 2's deliberate-break test (`STEP 2b` in the evidence log).

Every rung of the `composeBox` chain was rewritten to a selector that is valid CSS and
matches nothing — which is what a WhatsApp redesign looks like from inside the
extension — and the `sendButton` chain was left intact, so the run exercises the case the
two-canary design exists for. Resolution returned `null` rather than throwing;
`selector_failed` was logged with the target, all attempted selectors and a timestamp; a
persisted counter appeared in `chrome.storage.local`
(`{"composeBox":{"count":2,"firstSeen":"…","lastSeen":"…"}}`), so the outage is
answerable after the fact rather than only while someone is watching. The indicator
appeared reading *"StillWithYou couldn't attach — WhatsApp may have updated"*, naming
WhatsApp as the likely cause rather than leaving the user suspecting their own setup.
Typing 30 characters into the broken page produced no crash and no uncaught error in the
page context, and WhatsApp's own send handler still fired. Reverting the selector
restored a green health check with the indicator removed, on the same page load path.

**This is the one failure mode that is loud on purpose.** The others fail silently
because the user has no stake in them; this one means the extension is silently useless,
and silence would be read as "your message is fine".

**A real defect this test caught.** The health chip was originally positioned at
`bottom: 16px; right: 16px` — exactly where WhatsApp's send button sits. It shifted
nothing in WhatsApp's layout and still broke the page, by *occluding* an interactive
control. No screenshot would have shown it; it surfaced only because the harness clicks
the send button and asserts the click landed. The rule "must not break WhatsApp's
layout" turned out to be too weak, and the stricter one — must not cover a control — is
now an assertion comparing the two bounding rects, applied to the banner as well as the
indicator.

### 2. The backend is unreachable

**Handled by:** the failure classification in `api.js` and the no-op path in
`content.js`.
**Verified by:** Step 4's stopped-backend test (`FAILURE MODE 2` in the evidence log).

With nothing listening on the target port, `analyzePreview` resolved
`{ok: false, reason: "unreachable", elapsedMs: 1}` rather than rejecting, and the content
script logged `analysis_unavailable` and stopped. **Nothing was added to the page** — no
banner, no indicator, no element matching `.swy-banner, .swy-health` — and no uncaught
error reached the page context. WhatsApp's own send button still worked.

The health indicator deliberately does **not** appear here, and the test asserts its
absence. A down backend is not a DOM problem, the user cannot act on it, and on a local
dev machine it is the expected state most of the time. Showing a chip for it would train
the user to ignore the one signal that does matter. A WhatsApp Web user who has never
heard of this project must not be shown an error from it.

### 3. The backend is slow (>3s)

**Handled by:** the `AbortController` deadline in `api.js`, plus a second guard timer in
`content.js` for the case where the service worker itself never answers.
**Verified by:** Step 6's delayed-response test (`FAILURE MODE 3` in the evidence log).

Against a server that answers after 6s — twice the deadline, so the result is not a race
— the request aborted at a **measured 3017ms** (3010ms on a second run) with
`reason: "timeout"`. No banner, nothing user-visible added, the timeout logged, no
uncaught error, and a click on the send button still registered while the request was
outstanding, confirming the page stayed usable.

3s is the same figure as Phase 4 Step 6 and the backend's `gemini_timeout_seconds`, and
the margin is wide: `/analyze-preview` measures 44–55ms warm for a real inference and
10–16ms on a cache hit. `AbortController` rather than `Promise.race` because racing
leaves the request in flight, so a merely-slow backend would accumulate one abandoned
connection per typing pause.

**This deadline used to fire in normal operation, on the first request after every
restart. That is now fixed — see the next section.**

---

## Testing boundary

Per the brief's constraint, and worth stating as scope rather than as a footnote:
**testing happens only against the author's own WhatsApp account and self-authored test
messages.** The heated messages used as evidence are typed by the author, to themselves or
to a test conversation. No real contact's messages are read, captured, screenshotted or
analysed, and no conversation is used as test material without the other person's
knowledge. Screenshots for Step 5 have contact names and message history cropped or
obscured.

---

## Cold start — the risk this phase found, and its fix

**Status: resolved.** Recorded here in full because the first version of the fix did not
work, and the reason it did not work is the interesting part.

Reproduce either state with `backend/scripts/measure_cold_start.py`, which starts a real
uvicorn subprocess, waits only until the port accepts a TCP connection, and immediately
sends a real request. That "immediately" is the whole method — the defect is invisible
unless the request races the boot, which is exactly what a user restarting the backend
and switching to WhatsApp does.

### The defect

The model was loaded on a background thread at startup, so the API could begin serving at
once. Measured on a fresh process:

```
boot -> port accepts TCP          5286 ms
GET  /health (immediate)           696 ms   {"status": "ok"}
POST /analyze-preview  #1         3030 ms   <- TIMED OUT at the client's 3s deadline
POST /analyze-preview  #2        31752 ms   <- waited out the load
preview_model_ready              34004 ms
```

Two defects, not one:

1. **The endpoint blocked past the caller's deadline.** The socket opened at 5.3s and the
   model was not resident until 34.0s, so every request in that 29-second window queued
   behind the load lock. The extension gave up at 3s and showed nothing.
2. **`/health` answered `ok` throughout.** The only observable readiness signal said
   "fine" for the entire window. Nothing distinguished *warming up* from *broken*, so the
   failure was undiagnosable from outside as well as unhandled.

The background thread was chosen to keep boot fast. It bought a fast boot by moving the
cost onto whichever real request arrived first — the same trade Phase 2 rejected for
Gemini, made again here without noticing.

**The documented 8.22s was also wrong, by 4×.** That figure came from a standalone
process on an otherwise idle machine. Re-measured with Postgres, Redis, Prometheus, a
second uvicorn and a browser running, the load is **27.6–34.0s**. Of that, ~9s is a
network metadata check to huggingface.co: measured **33.9s online against 24.9s with
`HF_HUB_OFFLINE=1`**. Setting that flag is a real ~9s saving and is *not* done here,
because it would break the first-ever run on a machine without the model cached; it is
recorded as a follow-up rather than taken silently.

### The fix

`load_preview_model()` is now **awaited from `lifespan`**, immediately before `yield`.
The app already used the lifespan context manager, so no `@app.on_event` was involved —
that decorator is deprecated in FastAPI 0.115.0, which is what is installed.

**Verified rather than assumed:** uvicorn does not open the listening socket until
lifespan startup returns. In the before-run the port accepted TCP at 5.3s while the model
loaded behind it; in the after-run the port does not accept until 34.2s, after
`preview_model_ready`. So during the load a caller gets an immediate connection refusal,
not a hang — which for the extension is the `unreachable` branch that is already
specified to fail silently. A closed port is a more honest signal than a `/health` that
claims readiness it does not have.

The load runs in `asyncio.to_thread` rather than inline, so the event loop stays
responsive and the process still answers Ctrl+C during a 30-second boot. A failed load is
logged and swallowed rather than aborting startup: the rest of the API has nothing to do
with this model, and `analyze_multilingual` degrades to the Phase 2 lexicon on its own.

`analyze_multilingual`'s per-call logic is unchanged. Only when the model is constructed
moved.

### The first fix was incomplete

Eager loading alone left the first request at **1210ms client-side, 403ms server-side**,
against 146ms for the second. Loading the weights is not the whole cold start: the first
forward pass through a fresh torch model initialises lazy kernel selection, memory arenas
and thread pools, which Phase 3 had already measured as a 469.6ms one-off against a 40ms
median. `warm()` loaded the weights and never ran an inference, so the cold start had
simply moved one layer down.

`warm()` now runs one throwaway inference on a fixed ASCII string. That is a load-path
change, not an inference change — the result is discarded and no caller can observe it.

### After

```
boot -> port accepts TCP         34226 ms   (model load 30189 ms of it)
GET  /health (immediate)         167.7 ms   {"status": "ok", "preview_model": "ready"}
POST /analyze-preview  #1       1052.2 ms   <- within deadline  (server-side 200 ms)
POST /analyze-preview  #2        176.6 ms                       (server-side 164 ms)
POST /analyze-preview  #3        227.4 ms                       (server-side 196 ms)
GET  /health (warm, control)       6.3 ms
```

**Server-side, the first request is 200ms against 164ms and 196ms for the next two** —
indistinguishable from steady state. The request that previously timed out now completes
with roughly 3× margin on the deadline.

The remaining client-side gap on request #1 is not the model. The warm `/health` control
answers in 6.3ms against 167.7ms cold, which locates the cost in per-process first-call
overhead — socket setup in the client, and FastAPI's per-route first-call setup of the
response-model serializer and body validator on the server. It is left alone: ~1.05s
against a 3s deadline is adequate margin, and self-requesting at startup to shave it
would be more mechanism than the problem deserves.

### Boot-to-ready, and whether that is acceptable

**Boot-to-ready is now 32.1–34.2s, up from ~5.3s, and the trade is accepted.** A slow,
visible, once-per-restart cost paid by whoever runs the process is strictly better than a
hidden one paid by whichever user's message happened to be first — and it is now
observable rather than inferred, since `/health` reports `ready`, `unavailable` or
`disabled` instead of a flat `ok`. `PREVIEW_ENABLED=false` skips the load entirely for
any deployment that does not serve the extension, which is asserted by a test rather than
assumed.

Two things this would need before it were more than a proof of concept: the 30s is long
enough to matter to a rolling deploy or a container healthcheck's start period, and
`HF_HUB_OFFLINE=1` would return ~9s of it. Neither is pursued here — the extension is
explicitly a local unpacked POC with no deployment story.

---

## Remote selector config — recovery, not just safe failure

Everything above is about failing *safely* when WhatsApp's DOM moves. This is the other
half: recovering *quickly*. Design, host choice and threat model in
[`phase5-remote-config.md`](phase5-remote-config.md); evidence in
[`phase5-config-evidence.txt`](phase5-config-evidence.txt) — **45/45 checks**.

The selector chains now come from
[`extension-config/selectors.json`](../extension-config/selectors.json), fetched at
runtime. A DOM change becomes a config push instead of a code edit plus an extension
reload plus a re-test for every user.

### Three tiers, all three verified

| source | when | verified |
|---|---|---|
| `remote` | fetched from GitHub | Step 3a — fetched, applied, written to `chrome.storage.local` with a timestamp |
| `cache` | fetch failed, last-known-good exists | Step 3b — network blocked, cached config used, **no health indicator** (a config outage is not a DOM outage) |
| `hardcoded` | no network *and* no cache | Step 3c — frozen snapshot in `selectors.js`, compose box still resolves |

`config_source` is logged on **every** path, every load, so a console paste answers
"which selectors am I actually running" without inference. Without that, "the selectors
are wrong" and "the config never loaded" look identical.

**A bug this found.** A reachable-but-malformed config originally returned
`unavailable` without consulting the cache — so one bad push dropped every client to the
frozen snapshot, while merely being *offline* correctly kept last-known-good. Backwards:
a bad push is both more likely and more in need of a limited blast radius. Both failure
paths now share one `fallbackToCache`, verified by Step 3d — the good cache entry
survives a garbage push, and the garbage is never written.

### The load sequence never waits for the network

`selectors.js` boots with the frozen snapshot active synchronously. The fetch is fired
after the observer is running and is never awaited; a better config swaps in when it
arrives, typically 3–9ms locally. Awaiting it would put a third-party HTTP request in the
critical path of WhatsApp Web's own page load, on every load — the failure mode being
that a slow GitHub makes WhatsApp feel slow, which is the one thing this phase is
organised around never doing. Fetch deadline is 2.5s, deliberately under the analysis
call's 3s since nothing is waiting on the result.

### Self-tuning selector order

The index that last resolved is remembered per target and tried first, persisted so the
hint survives a reload. After a partial DOM change the config's priority order is wrong,
and without this every resolution re-pays the failed queries on every mutation until
someone pushes a reordered config.

Measured with the first rung dead:

```
1st resolution (hint cleared)  attempted 2 selectors, matched index 1
learned hint                   {"composeBox": 1}
next attempt order             [1,0,2,3]   (config order is [0,1,2,3])
2nd resolution                 attempted 1 selector,  matched index 1
```

The hint is a **hint, never a filter** — the full ordered list is still tried after it,
so a stale hint costs one extra query and can never make a resolvable target
unresolvable. Step 4b asserts it changes nothing when healthy: attempt order stays
`[0,1,2,3]`, one attempt both times.

### Step 5 — a config push recovering a broken extension

Every selector in the shipped config was replaced with a dead one, simulating a WhatsApp
change. Then **only the JSON was edited** — no extension file touched, nothing rebuilt,
nothing reloaded from disk:

```
BEFORE  config v3: health=detached, indicator=true    <- user sees "couldn't attach"
>>> edited selectors.json only: v3 -> v4. No extension code changed. <<<
AFTER   config v4: health=attached, indicator=false   <- recovered

Recovery required: 1 JSON edit. Extension code changed: 0 files.
```

That is the concrete evidence for "a DOM change is a config push, not a code release".

**Verified against a local HTTP server, not GitHub.** Serving locally is what makes this
testable in one run — against the real repo it would need a commit, a push and a CDN
wait. What is *not* proven here: that `raw.githubusercontent.com` is reachable from the
extension, and that GitHub's ~5-minute raw cache behaves as documented. Those need the
config file actually pushed and are the real-site half of this step.

### What this does not solve

It handles **selector strings changing while the structure stays reachable** — the common
case. It does **not** survive structural change: a closed Shadow DOM, a cross-origin
iframe, or a canvas-rendered compose box is unreachable by any CSS selector, and no
config push helps. The health check still fires correctly there; the extension just
cannot be fixed remotely.

---

## Evidence status — what is verified and what is not

This section exists because the distinction is easy to blur and the project's whole
claim is that it does not blur it.

### Verified automatically, and re-runnable

`extension/fixtures/run-evidence.mjs` loads the extension's **real source files** —
`selectors.js`, `health_check.js`, `banner.js`, `content.js`, `api.js`, unmodified —
into headless Chrome against a local replica of WhatsApp's compose-box DOM, and drives
them against the **real backend over real HTTP**. 50/50 checks, output in
[`phase5-evidence.txt`](phase5-evidence.txt).

```bash
cd extension/fixtures && npm install && node run-evidence.mjs
```

This covers the selector chain and its degradation, the failure counter, the health
indicator, the debounce, the banner threshold and DOM, the overlay non-occlusion rule,
the 3s abort, and the "nothing user-visible on failure" contract. Those are properties of
*this project's code*, and testing them against a live WhatsApp session would be slower,
unrepeatable and no more truthful.

The backend side is covered by `backend/tests/test_analyze_preview.py` — 8 tests, real
Postgres and real Redis, taking the suite from 21 to **29 passing**. The load-bearing one
is `test_preview_writes_no_message_row`.

### NOT verified — needs a logged-in browser

Three of the brief's DONE WHEN criteria require a real WhatsApp Web session and cannot be
produced any other way:

| Step | What is still unproven |
|---|---|
| 1 | That the manifest loads and the content script runs on `web.whatsapp.com` |
| 3 | That the selectors match **today's** real WhatsApp DOM |
| 5 | How the banner sits over a real conversation |

**Step 3 is the substantive one.** The fixture reproduces the attributes `selectors.js`
keys on *as recorded at the time of writing*. Passing against it proves the extension
works against the DOM as recorded here — not that the recording is still accurate. The
fixture is a copy of a moving target and goes stale in exactly the same way the selectors
do, which is the entire premise of this phase and is why a visible health check exists
rather than a test.

`docs/phase5-fixture-banner.png` shows the banner rendering **on the fixture**. It is
illustrative of the component, and it is not a substitute for Step 5's screenshot.

### Capture procedure for the real-site steps

1. `docker compose up -d`, then start the API (`uvicorn app.main:app --port 8000`). Wait
   for `preview_model_ready` in the log — before that line, the first request will hit
   the 3s deadline.
2. `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`.
3. Open `web.whatsapp.com`, log in with your own account, open a test conversation —
   **a note-to-self chat, not another person's thread.**
4. DevTools → Console → filter on `[StillWithYou]`.
   - **Step 1 evidence:** the `content_script_loaded` line.
   - **Step 2 evidence on the real site:** confirm `health_check` reports
     `healthy: true`, and note `matchedIndex` for each target. Anything above `0` means
     the preferred selector has already drifted and `selectors.js` needs updating.
5. Type three or four messages, pausing ~2s after each. Copy the `draft_captured` and
   `analysis_result` lines — **Step 3 evidence.** Confirm one capture per message rather
   than per keystroke.
6. Type a genuinely heated message of your own. Screenshot the banner over the
   conversation with contact names and history cropped — **Step 5 evidence.** Save as
   `docs/phase5-step5-banner.png`.
7. Stop the backend and type another heated message. Confirm no banner and no visible
   error — **Step 4's graceful-failure evidence on the real site.**

If step 4 shows `healthy: false`, that is not a failed capture. It is the phase's
central thesis arriving early, and the health indicator plus the `attempted` list in the
log is exactly the diagnostic the design exists to produce. Record it and update the
selector chain.

---

## Definition of done for Phase 5

- [x] Scope, risk statement and read-only boundary written down before any extension code
  (Step 0) — this document.
- [ ] **Manifest V3 scaffold loads on the real site, confirmed by console marker
  (Step 1) — needs the capture above.** Scaffold written; marker verified on the fixture.
- [x] Selector resilience layer: structured warning, persisted failure count, `null`
  rather than throw; health-check indicator on failure (Step 2), verified by deliberately
  breaking a selector and then reverting — `STEP 2a/2b/2c` in the evidence log.
- [x] Compose box read on a ~1.5s debounce with no per-keystroke traffic (Step 3) —
  4 messages, 197 keystrokes, **4 captures and 4 backend calls**. *Real-site capture of
  the same still outstanding, and it is the one that also tests the selectors.*
- [x] `POST /analyze-preview` added, with a real request/response pair and verified
  graceful behaviour when the backend is stopped (Step 4) — 8 backend tests, and
  `FAILURE MODE 2` in the evidence log.
- [x] Nudge banner overlay renders on a heated message without covering WhatsApp's
  controls (Step 5) — `docs/phase5-fixture-banner.png`, plus non-occlusion assertions.
  **The real-conversation screenshot the brief asks for is still outstanding.**
- [x] All three failure modes written up with verified behaviour (Step 6).
- [ ] `docs/progress.md` records the phase, its proof-of-concept status, its unpublished
  status and the read-only boundary (Step 7).

---

## Known limitation: the nudge can arrive after the message is already sent

**Status: diagnosed, measured, NOT fixed.** Reported from real use on WhatsApp Web —
"you are a disgrace" was typed and sent, and the banner appeared *after* the message was
already in the thread, which defeats the entire point of the product.

Reproduction harness: `extension/fixtures/run-race-repro.mjs`.

### The mechanism, stated precisely

Analysis starts at **last keystroke + 1500ms**, and that timer knows nothing about the
send. The send is not observed — by design, because observing it would require binding to
the send button or to Enter, which the read-only boundary forbids. So the two events are
simply uncoordinated, and which one lands first is decided by how long the user pauses
before sending.

That produces **two distinct failures**, not one:

| send lands | what happens | user sees |
|---|---|---|
| more than ~1500ms before the debounce boundary | box is empty when the timer fires, text falls under `MIN_CHARS`, **no analysis is ever requested** | nothing, ever |
| within ~200ms of the boundary | analysis reads the text just before the clear, then the ~200ms round trip lands after the message is gone | **banner appears after the message was sent** |
| comfortably after the boundary | analysis completes before the send | correct behaviour |

Measured, 18 characters at 60ms/char against a warm local backend:

```
send 180ms after last keystroke   (x3 runs, both clear-variants = 6 runs)
  input_start                    +    0ms
  send_detected                  + ~1740ms
  debounce_fired                 + ~2970ms      <- 1250ms AFTER the send
  banner                         NEVER MOUNTED

send ~1600ms after last keystroke
  debounce_fired                 + 7084ms
  analysis_request_sent          + 7085ms
  analysis_response_received     + 7247ms       <- 162ms round trip
  banner_mounted                 + 7283ms       <- AFTER the message left the box
  banner_rendered                + 7284ms  heat=0.63
```

`heat=0.63` and "reads as angry" reproduce the reported screenshot exactly.

### What the evidence does and does not settle

**Hypothesis (c), a stale banner, is ruled out.** Sending a calm message first
(`heat=0`) and then the heated one showed the banner carrying the *current* message's
text and score. This is not the Track A staleness pattern repeating.

**The briefed "fast send" hypothesis is not what produced the screenshot.** Sending
180ms after the last keystroke reproduced in 6/6 runs — but its outcome is *no banner at
all*, not a late one. For the banner to appear, analysis must have read the text before
the box was cleared, which means the debounce fired essentially simultaneously with the
send. The observed case is the narrow boundary regime, not the common fast one.

**Which side of the boundary the real send fell on is not settled by fixture data.** The
fixture's send is a scripted clear, so its exact ordering against the debounce is an
artifact of a script round-trip rather than of WhatsApp's own behaviour. The real-site
trace is what closes that, and it is outstanding.

### Why this exists — two correct decisions colliding

Neither half is a mistake, which is what makes it structural rather than a bug:

- **The 1500ms debounce is right.** Analysing per keystroke would be 15-30 requests per
  message. The pause is also the moment the product is actually aiming at — "stopped to
  think" rather than "moved between words."
- **Not observing the send is right.** It is the read-only boundary, and that boundary is
  the reason this extension can be trusted to run on somebody's real conversations at
  all. Relaxing it to fix timing would trade the phase's central guarantee for a feature.

Together they mean the product cannot know when it is out of time. The debounce assumes
the user is still typing; the read-only rule forbids learning otherwise.

### Which failure matters more

**The silent one.** A late banner is visible and at least tells the user something true
about a message they can still follow up on. Sending inside 1500ms produces *nothing* —
no banner, no log a user would see, no indication the extension considered the message
at all. And it selects for exactly the messages the product exists to catch: short,
fast, emotionally reactive ones. "you are a disgrace" is 18 characters; typed at a
natural angry pace and sent immediately, it is never analysed.

That is the honest headline: **for the fastest and most reactive messages, this extension
currently does nothing, and its silence is indistinguishable from a verdict of calm** —
the same failure mode the health-check indicator was built to avoid, arriving through a
different door.

### Not fixed here, and the obvious fixes are not free

Recorded so the next person does not reach for one without seeing the cost:

- **Shorten the debounce.** Cheap, and it narrows the silent window without closing it —
  a fast sender still beats any non-zero timer. It also multiplies request volume on an
  extension already documented as a worse citizen of the backend than the main app.
- **Analyse on send.** Closes it completely and is forbidden: it requires observing the
  send path.
- **Analyse on a length trigger** (e.g. once past `MIN_CHARS`, independent of pause).
  Read-only, and it would have caught this message. Costs more requests, and needs
  thought about what happens while the user is mid-word.
- **Keep analysing after the box empties**, then show the nudge against the sent message
  rather than the draft. Read-only and always in time, but it changes the product from
  "pause before you send" to "here is what you just sent", which is a different and much
  weaker proposition.

None is obviously correct, which is why this is documented rather than patched.

### Real-site confirmation (2026-07-29) — and two corrections to the fixture estimates

Captured from the extension loaded unpacked in Chrome on `web.whatsapp.com`, five
messages sent in sequence.

**The silent failure is confirmed, and it is the dominant one.**

```
02:13:45.700  draft_captured   chars:6                      <- under MIN_CHARS, no analysis
02:13:50.313  draft_captured   chars:10
02:13:50.656  analysis_result  mood:angry heat:0.61 elapsed_ms:131 over_threshold:true
02:13:50.676  banner_shown     tone:angry heat:0.61         <- 363ms after the debounce fired
02:14:41.543  draft_captured   chars:0                      <- box already empty
02:14:51.152  draft_captured   chars:0
02:15:06.384  draft_captured   chars:0
```

`chars:0` is the mechanism caught in the act. The debounce fired, read the compose box,
found it empty because the message had already been sent, fell under `MIN_CHARS`, and
returned without requesting analysis. **Three of five messages produced no analysis at
all** — and the three that got nothing were the fast, short, escalating ones typed in
quick succession, exactly the population the product exists to catch. The two that were
analysed were the ones the user paused on.

**Correction 1: the late-banner window is far wider than the fixture suggested.** The
fixture measured a warm round trip of ~200ms and inferred a ~200ms exposure. The real
capture of the originally-reported message shows:

```
01:49:14.989  analysis_result  mood:angry heat:0.63 elapsed_ms:1332
01:49:15.006  banner_shown     heat:0.63
```

**`elapsed_ms: 1332`** — nearly ten times the fixture's warm figure, so the debounce-to-
banner gap was ~1350ms rather than ~200ms. That is why this was hit in ordinary use
rather than being a knife-edge coincidence. Backend latency directly sets the width of
the window in which a nudge can arrive too late, and the fixture's warm-cache numbers
understated it badly. Any future estimate of this risk has to use realistic first-request
latency, not steady-state.

**Correction 2: a banner that arrives in time still does not stop the send.** On the
third message the banner appeared *before* the user hit send, and they sent anyway. That
is correct behaviour — the read-only boundary means the extension cannot and must not
gate the send — but it is worth stating as a product limit rather than leaving implied:
**the nudge is advisory, and an advisory shown to someone mid-escalation is easy to send
straight past.** Being on time is necessary and not sufficient.

### The `detached` indicator has a false-positive mode (separate bug)

Also visible in the same capture:

```
01:53:48.730  selector_failed  composeBox attempted:5
01:53:49.104  health_check     state:detached from:idle detail:compose_box_not_found
01:53:54.466  compose_box_attached                        <- recovered after 5s
...
02:00:00.665  selector_failed  composeBox attempted:5
02:00:32.378  compose_box_attached                        <- recovered after 32s
```

`compose_box_attached` recurs throughout the session, so WhatsApp is replacing the
compose box node routinely. Between the old node going away and the new one being found,
`#main` still matches `conversationOpen`, so the health check concludes "a conversation is
open but the compose box is gone" and shows the "couldn't attach" indicator. It recovers
on its own in 5–32s.

This is the crying-wolf failure again, one layer in. The earlier fix distinguished *no
chat open* from *a real outage*; it does not yet distinguish *a real outage* from *the
compose box being mid-replacement*.

**The obvious config-only fix is wrong and is deliberately not applied.** Tightening
`conversationOpen` to require the compose box itself would silence the false positive —
and would also silence the true positive, because a genuine selector break would then
read as `idle` rather than `detached`. That trades a visible false alarm for an invisible
real one, which is precisely the wrong direction for a design whose stated premise is
that absence of a warning must never be mistakable for calm. The right fix is a grace
period — require the compose box to be missing for several seconds *while* a conversation
is open before declaring `detached` — and that is code, not config. Not done here.

### Track B's outstanding item is closed, incidentally

The same capture contains the one thing the live-CDN verification could not reach:

```
02:12:23.780  config_source   source:"remote" version:2 updated:"2026-07-29T00:00:00Z"
                              compose_selectors:5 elapsed_ms:1020
02:12:23.781  config_applied  source:"remote"
```

That is the real extension, loaded unpacked, fetching the config from
`raw.githubusercontent.com` under the manifest's `host_permissions` and applying it —
verified inside the extension sandbox rather than merely running `config_source.js` as
the service worker would. Version 2 is the config pushed during the B2 propagation test.

```
02:12:22.754  health_check  state:"idle" detail:"no_conversation_open"
```

And the earlier crying-wolf fix behaving correctly on the real site: the landing screen
reports `idle` and shows no indicator.

### The fragment trigger was built, measured across 40 messages, and switched off

An attempt to close the silent-failure gap: take one look while the user is still typing,
so a message sent inside `DEBOUNCE_MS` is still examined. It is implemented, single-shot,
and **disabled** (`FRAGMENT_TRIGGER_ENABLED: false`). The gap remains open.

**Trigger length and threshold are coupled, and were measured together.** The length
decides which messages can ever be examined; the threshold decides whether what it sees
is acted on. An earlier attempt fixed the length at a guess and fitted the threshold to
four hand-picked angry messages, arriving at 0.50 — which then caught 0 of 10 heated
fragments on a representative set. The real measurement is a grid: **40 messages × 4
trigger lengths × 3 thresholds**, fragments always cut at a word boundary.

Two fixture sets, kept separate on purpose — a blended number would average away the one
thing each set is uniquely able to show:

- **20 from the Phase 3 corpus** (60–90 chars). The only set with genuinely long calm
  messages, so it measures **false-fire risk**. It cannot measure coverage: every message
  is long enough to reach every trigger length, so reachability is 100% by construction.
- **20 short messages written blind for this test** (10–19 chars), labelled before
  scoring, and free of the analyzer's insult lexicon *and* its absolutes (`never`,
  `always`, `every time`) — stricter than the original corpus rule, so the heated ones
  test the model rather than a keyword lookup. This is the only set that can measure
  **reachability**, which is the axis the whole question turns on.

**The surface, best cell in bold:**

| L | thr | catch (short set) | false fire | heated unreachable |
|---|---|---|---|---|
| 10 | 0.45 | 2/10 (20%) | 0/10 | 2 |
| **12** | **0.45** | **2/10 (20%)** | **0/10** | **1** |
| 14 | 0.50 | 2/10 (20%) | 0/10 | 5 |
| 16 | 0.55 | 0/10 (0%) | 0/10 | 5 |

On the long-message corpus, catch is 0–10% at every cell. **Four of five heated messages
get no warning at any setting**, so there is no pair worth shipping.

**The message-length floor.** A trigger of L characters can only examine messages of at
least L characters. Reachability on the short set: L=10 reaches 10/10 heated, L=12 9/10,
L=14 5/10, L=16 5/10. A long trigger is structurally blind to short messages — and short
messages are the failing population. **Any fragment trigger has a floor below which it
cannot help at all**, and that floor is its own trigger length.

**Why shortening the trigger does not rescue it.** `"you are a disgrace"` — the message
this investigation started from — is never caught:

```
L=10   0.18   "you are a"
L=12   0.18   "you are a"
L=14   unreachable  (nearest word boundary is char 9)
```

The heat lives in the word *being typed*, and a word-boundary cut always truncates
immediately before it. Measured mid-word for contrast — **n=4, unrepresentative** —
`"you are a disg"` scores 0.59 against `"you are a"` at 0.18. That suggests the
word-boundary rule, adopted to avoid feeding the tokenizer odd input, is what removes the
signal. It is **logged as an untested hypothesis, not a finding**: four hand-picked
examples are exactly the evidence that produced the discredited 0.50. Testing it means
re-running the full grid mid-word.

**Fragments are not noisier when shorter — they are flatter.** Mean |fragment − full| is
flat at ~0.14 across all four lengths on the corpus set. The worst divergences are all
heated messages *underestimated* (−0.45, −0.29), never calm ones overestimated. The
failure mode is systematic underestimation, not variance, which is why no threshold
separates the classes.

**A prediction made before scoring, and half wrong.** L=10–12 having the best coverage was
predicted correctly. False-fire being *worse* at short lengths was predicted and is
backwards — it is ~0 everywhere, and the single false fire in the whole surface occurs at
the *longest* length. The reasoning behind the error is worth keeping: a short fragment of
a calm message was expected to read as hot, and instead reads as cold. Everything reads as
cold, which is the same fact that destroys the catch rate.

**Net effect: the silent-failure gap stays open and documented.** That is a better state
than a feature that fires on 2 of 10 genuine warnings.

