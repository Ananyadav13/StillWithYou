# Phase 3 — scope: multilingual mood and toxicity detection

**Last updated:** 2026-07-27

Phase 3 adds mood, toxicity and heat scoring for exactly three input modes —
**English**, **Hindi in Devanagari script**, and **Hinglish** (Latin-script
Hindi-English code-switching) — and it runs entirely on a **self-hosted local model,
not Gemini**. This is an architectural decision forced by an external block: all three
Gemini keys are unusable as of 2026-07-27 (two hang past 25s, one returns a
project-level `403 PERMISSION_DENIED`), which is documented in
[`docs/progress.md`](progress.md). While that block stands, **nothing in this codebase,
its docs, or its logs may claim Gemini-backed multilingual support** — the analysis
that actually runs is a local open-weight model, and `source` must say so.

---

## In scope

- Detecting `mood`, `toxicity_score` and `heat_score` for:
  - **`en`** — English
  - **`hi`** — Hindi written in Devanagari script (आप हमेशा ऐसा ही करते हो)
  - **`hi-en-mixed`** — Hinglish, romanized Hindi code-switched with English
    (tum hamesha aisa hi karte ho, seriously?)
- Detecting *which* of those three modes a message is, so the result can be labelled
  and measured per mode.
- A local, free, CPU-runnable model as the **active** analysis path.
- Per-language accuracy measurement against a hand-written fixture corpus.

## Out of scope

- **Any other language.** Not Marathi, Bengali, Tamil, Urdu, or any of the other
  languages the chosen model's card happens to list. Three modes, no more.
- **Transliteration correction.** `karte`/`karthe`/`krte` are not normalized to a
  canonical spelling as a goal in itself. (A normalization step may be introduced in
  Step 5 purely as an accuracy fix, if measurement shows Hinglish is weak.)
- **Translation.** Nothing is translated into English before or after analysis, and no
  translated text is shown to the user.
- **Any translation UI, language switcher, or language picker.** Step 8 is a font
  rendering check only.
- **Sarcasm, gaslighting and manipulation-pattern detection.** Phase 3 measures overt
  mood and toxicity only. A calmly-worded manipulative message and a calmly-worded
  kind one are indistinguishable to everything built here, and the fixture corpus
  contains no sarcasm or manipulation examples, so nothing in the Phase 3 numbers says
  anything about them either way. This is a deliberate boundary rather than an
  oversight — but it is a real gap in a product whose thesis is partly about
  manipulative communication, and it should not be allowed to become an unstated one.
- Avatar work and the browser extension — later phases.

## Architecture decision: local model, zero Gemini dependency

| | |
|---|---|
| Analysis engine | open-weight model from Hugging Face, run locally on CPU |
| Cost | zero — no paid API, no billing account, no credit card |
| Gemini's role | **coded but dormant.** It stays wired as the nominal "primary" branch of the Phase 2 circuit breaker so that re-enabling it is a config flip, not a rewrite. It is not called. |
| `source` value | `multilingual_local` — never `gemini` |

The Phase 2 resilience machinery (circuit breaker, Redis cache, ARQ job queue,
`local_fallback` lexicon) is unchanged and still underneath this. Phase 3 replaces
*which analyzer is active*, not *how analysis is scheduled or degraded*. The Phase 2
`local_fallback` lexicon remains the last-resort path if the local model itself fails
to load.

### Why this is written down

The honest framing matters more than the feature. A reader six months from now needs to
know that "multilingual support" here means *three named modes scored by a small local
classifier*, not *a frontier model handling arbitrary languages*. Overstating it in a
commit message or a log line would make the accuracy numbers in
[`docs/phase3-results.md`](phase3-results.md) unreadable.

## Language naming rule

Never write "multi-language support" or "supports many languages" without naming the
three modes. The accepted phrasings are "English, Hindi and Hinglish" or the tags
`en` / `hi` / `hi-en-mixed`.
