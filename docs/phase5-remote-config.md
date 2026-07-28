# Phase 5 — remote selector config

**Last updated:** 2026-07-28
**Status:** proof of concept, same as the rest of Phase 5.

The extension's selectors are the part of it guaranteed to rot. This makes them a
**runtime-fetched JSON file** instead of code, so recovering from a WhatsApp DOM change
is a config push rather than a code edit, an extension reload and a re-test.

The rest of Phase 5 is about failing *safely* when the DOM moves. This is about
**recovering quickly** — the other half of the same problem, and the one that decides
whether the extension is usable for more than a week at a time.

---

## The gap this closes

The first real test against `web.whatsapp.com` made the maintenance cost concrete. Any
selector change previously meant: edit `selectors.js`, reload the unpacked extension,
re-run the fixture harness, re-test on the real site. Every user of the extension has to
do all of that, and until they do the extension is dead. For an integration surface that
*will* break periodically by design, "the fix requires a release" is the actual failure
mode, not the broken selector.

With config fetched at runtime, the same fix is: edit one JSON file, commit. Every
running extension picks it up on its next load.

---

## The choice: a raw file in this repo

```
https://raw.githubusercontent.com/Ananyadav13/StillWithYou/main/extension-config/selectors.json
```

Served by GitHub from `extension-config/selectors.json` on `main`.

**Why this and not something better.** The requirement is "editable in minutes, no new
infrastructure". This needs no hosting, no deploy, no account beyond the one the repo
already lives in, and it is editable through GitHub's web UI from a phone. The config
lives in the same repo as the code that consumes it, so a selector change is reviewable
in the same place and in the same history as everything else — which for a
proof-of-concept is worth more than any operational property a dedicated service would
add.

**Alternatives considered:**

| Option | Why not |
|---|---|
| GitHub Pages | Needs Pages enabled and a build/publish step, and updates lag a Pages build. Raw is immediate and has no setup at all. The only thing Pages buys here is a nicer URL. |
| Gist | Editable in minutes too, but it lives outside the repo — the config would drift out of the history that explains it, and the frozen fallback in `selectors.js` could no longer be diffed against its source. |
| A `/config` endpoint on the existing FastAPI backend | Wrong dependency direction. The backend is `127.0.0.1` on a laptop, so config would be unavailable exactly when the backend is down — and the whole point is that the extension keeps working, silently, without it. |
| Dedicated config service + CDN | Correct for production, and explicitly out of scope. See below. |

**What a production version would need, and this deliberately does not have:** a
dedicated config service with staged rollout and instant rollback; schema versioning with
a compatibility contract rather than one `version` integer; a CDN with predictable cache
semantics instead of GitHub's opaque ~5-minute edge cache; signed config so the extension
can verify provenance; and per-extension-version config pinning so an old client is not
handed a config shape it cannot parse. None of that is justified for a local unpacked
extension with one user, and pretending otherwise would be the kind of infrastructure
theatre this project avoids elsewhere.

---

## Cache latency, stated plainly

`raw.githubusercontent.com` sits behind a CDN with roughly a **5-minute** cache. A pushed
fix is therefore live in about five minutes, not instantly. That is well inside the
"minutes, not a release cycle" goal, but it is a real number and it is worth knowing
before someone pushes a fix and concludes it did not work because it did not take effect
in ten seconds.

---

## Threat model — the part that actually matters

Fetching executable behaviour from the internet deserves a straight answer about what an
attacker gets, because "it's only CSS selectors" is a weaker defence than it sounds.

**What the config controls:** which DOM element the extension reads text from and sends
to the backend. Nothing else. It cannot introduce code — the values are passed to
`document.querySelector`, never to `eval`, `innerHTML`, or a `Function` constructor.

**The realistic attack:** someone with write access to this repo repoints `composeBox` at
a *different* element on the page — a search field, or in principle any text node — and
that content starts being sent to whatever backend the user is running. That is a genuine
information-disclosure path, and it is worth naming rather than waving away.

**What bounds it:**

- **The read-only boundary is in code, not config.** The config cannot make the extension
  write to the page, intercept a send, patch `fetch`, or read the transcript. Those
  constraints live in `content.js` and are not configurable. The worst a hostile config
  achieves is reading the wrong element — it cannot escalate to modifying WhatsApp.
- **The destination is not configurable.** `API_BASE` stays hardcoded and
  `host_permissions` is scoped to `127.0.0.1:8000`, so exfiltration would have to go to
  the user's own local backend. A config push cannot redirect data anywhere.
- **Shape validation rejects anything that is not two arrays of strings.**
- **Write access to the config is write access to the extension's source anyway.**
  Both are the same repo. Anyone who can push a hostile config can push hostile
  `content.js`, which is strictly worse. This changes the blast radius of a repo
  compromise not at all.

That last point is what makes this acceptable *here* and would not make it acceptable in
production, where the config source and the code source would be separately controlled
and the config would be signed.

**`host_permissions` is scoped to the repo path, not the domain:**

```json
"https://raw.githubusercontent.com/Ananyadav13/StillWithYou/*"
```

Not `https://raw.githubusercontent.com/*`, which would grant read access to every public
repository on GitHub — far more than needed and an unnecessary permission to hold on a
page that also has WhatsApp open.

---

## What this does not solve

**It handles selector strings changing while the structure stays reachable.** That is the
common case and the one worth automating.

**It does not survive structural change.** If WhatsApp moves the compose box into a
closed Shadow DOM, renders it in a cross-origin iframe, or replaces the
`contenteditable` with a canvas, no CSS selector reaches it and no config push helps —
that needs new code. The health check still fires correctly in those cases; the
extension just cannot be fixed remotely.

The honest framing: this converts the *likely* breakage from a code release into a config
push, and leaves the *unlikely* breakage exactly where it was.


---

## Live verification against the real CDN (2026-07-29)

Everything above was designed and locally verified before the config file existed on
GitHub. This section is what happened when it did. Evidence:
[`phase5-live-cdn-evidence.txt`](phase5-live-cdn-evidence.txt).

### Reachability and cache headers — measured

```
GET https://raw.githubusercontent.com/Ananyadav13/StillWithYou/main/extension-config/selectors.json
HTTP/1.1 200 OK
Cache-Control: max-age=300
ETag: "df30b89267b815d06b5a58140c126d6211400f8c83514a1f4f843b34af1c835b"
X-Served-By: cache-maa10229-MAA
2123 bytes, 2.835s cold
```

`max-age=300` confirms the ~5 minute figure that was previously an estimate.

### B1 — the shipping fetch path against live GitHub

`config_source.js` run unmodified, then installed into the real `selectors.js` /
`remote_config.js` in headless Chrome:

```
loadConfig() -> source: remote   version: 1   elapsed_ms: 1134   cache write: yes
[StillWithYou] {"event":"config_source","source":"remote","version":1,"elapsed_ms":183}
selectors.source: remote    health: attached    page errors: none
```

### B2 — real propagation time: 248 seconds

`selectors.json` bumped to v2 and pushed, then polled every ~16s:

```
push completed          2026-07-28T19:00:04Z
attempt  1  t+   2.3s   source=remote  version=1
attempt  8  t+ 120.7s   source=remote  version=1
attempt 15  t+ 232.3s   source=remote  version=1
attempt 16  t+ 248.4s   source=remote  version=2   <- PROPAGATED
```

**4 minutes 8 seconds**, comfortably inside the `max-age=300` window and inside the
"minutes, not a release cycle" goal.

**An unplanned result worth more than the planned one:** attempts 2, 5 and 7 returned
`source=cache`. Live fetches to GitHub transiently failed mid-poll and the cache tier
engaged on its own, unprompted, in real conditions — the fallback demonstrated by an
actual intermittent failure rather than an injected one. Same shape as Phase 2's
resilience layer being validated by a genuine Gemini outage.

### B3 — the malformed-config fix holds against live GitHub

A deliberately malformed config was pushed to a throwaway branch,
`test/malformed-config`, which is **never merged**, so `main` never serves a broken
config even briefly. The branch is retained rather than deleted because
`fixtures/run-live-malformed-check.mjs` depends on it as a permanent test fixture.

```
test branch serves version 99, composeBox.selectors=[], sendButton=MISSING, conversationOpen=MISSING

[1] main    -> source=remote version=2 (123ms)
[2] test/…  -> source=cache  version=2 reason=invalid:empty_selectors:composeBox (106ms)

7/7 checks passed
```

Falls back to **cache**, not `unavailable`; the rejection names the specific validation
failure; the good cache entry survives untouched. The bug the local harness found — a
bad push being treated worse than being offline — is fixed in the wild too.

### What live verification did NOT cover

That Chrome grants the fetch under the manifest's `host_permissions` when the extension
is actually loaded unpacked. Everything here runs `config_source.js` as the service
worker would, but outside the extension sandbox. That single step needs a browser and
remains part of the outstanding real-site captures.
