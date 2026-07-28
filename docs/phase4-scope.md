# Phase 4 — scope: a 2D avatar reflecting detected mood

**Last updated:** 2026-07-28

Phase 4 adds a 2D animated avatar that reflects the mood the analysis pipeline already
detects. It is a **presentation layer only** — no new detection logic, no model change,
no backend change of any kind. The constraint that shapes every visual decision in this
phase is an accuracy one: **`angry` detection is measured at 6/15, and it sits behind a
regression floor with zero margin** (`docs/phase3-results.md`, and the per-category
floors in `test_multilingual_regression.py`). Nine of fifteen genuinely angry messages
are currently read as `frustrated` or `neutral`, because a polarity model cannot see
cold contempt. An avatar that renders `angry` as an alarm — a hard red flash, a shake, a
scowl the user reads as a verdict — would be **presenting a coin-flip as a diagnosis**,
and would do it in the most confident medium the product has. So the visual escalation
from `frustrated` to `angry` is deliberately *small*: the same character, a further step
along one continuous axis, no new visual vocabulary introduced at the top of the scale.
Where the pipeline is least reliable, the interface must be least emphatic. That
inversion is the point of this section, and Step 4 records it again at the point in the
code where it would be easiest to undo.

---

## The five states

The avatar has exactly five states. Four are the moods the pipeline actually emits, and
the fifth covers the window while analysis is in flight.

| State | Trigger | Notes |
|---|---|---|
| `idle` | `mood="calm"`, and every no-data case | The resting state. Also the fallback — see below. |
| `neutral` | `mood="neutral"` | Present, unremarkable. |
| `frustrated` | `mood="frustrated"` | First escalation step. |
| `angry` | `mood="angry"` | Second escalation step, deliberately close to `frustrated`. |
| `analyzing` | `analysis_status="pending"` | Covers the ~400–650ms measured send→`complete` window. |

The four mood values are not a design choice; they are enumerated in `_mood()` in
[`multilingual_local.py`](../backend/app/services/multilingual_local.py), which returns
`"angry"`, `"frustrated"`, `"calm"` or `"neutral"` and nothing else. The avatar adds no
state the pipeline cannot produce.

`calm` maps to `idle` rather than to a distinct "happy" state, following the analyzer's
own comment that `calm` covers both *warm* and *settled* — for this product's question
("should you send this?") a friendly message and a placid one are the same answer.

### Timing

The `analyzing` state is genuinely visible rather than a flicker: measured end-to-end
send→`complete` is **422–638ms**, and the frontend polls at 500ms intervals
([`useChat.ts`](../frontend/src/hooks/useChat.ts)), so resolution lands one or two poll
ticks after send. Transitions between states target **under 300ms** so the avatar reads
as responsive rather than laggy.

---

## Out of scope

- **Voice, lip-sync, audio of any kind, and ElevenLabs.** Nothing in this phase makes a
  sound or moves a mouth in time with one.
- **3D.** Flat 2D vector art only.
- **Any sixth state.** No "confused", no "sad", no "happy", no confidence tiers, no
  toxicity-driven or heat-driven variants. The pipeline emits four moods plus a status;
  the avatar has four moods plus a status.
- **New detection logic.** `multilingual_local.py`, `language_detect.py`, the worker and
  every other backend file are untouched. If the avatar looks wrong, the fix is in the
  avatar or it is a Phase 3 accuracy issue — it is never a quiet tweak to a threshold.
- **Rendering the other analysis fields.** `toxicity_score`, `heat_score` and
  `rewrite_suggestion` are received but not displayed by the avatar. Surfacing the
  rewrite suggestion is real product work and deserves its own phase, not a caption
  bolted to a face.

---

## Honesty constraint, stated concretely

The general rule above needs a testable form, because "don't oversell" is otherwise
unfalsifiable. The rule Phase 4 holds itself to:

> `angry` differs from `frustrated` by **one step along the same axes** — a slightly
> deeper accent colour, a slightly stronger brow angle, a slightly tighter mouth. It
> introduces **no visual device that `frustrated` does not also use**: no flashing, no
> shaking, no motion that repeats faster than the shared idle rhythm, no red-alert
> chrome, no size change, no exclamation iconography.

Stated that way it can actually be checked by looking at the two assets side by side,
which is what Step 2's debug grid is for.

### The restraint rule as a number

Looking at two faces and agreeing they feel proportionate is still a judgement, and a
judgement is not a constraint — nothing stops a later change from drifting past it.
Step 2 therefore measured the rendered geometry rather than trusting the authored
values. Displacement from `neutral`, in CSS px at `size=132`, taken from the live DOM
(`docs/phase4-step2-states.png`):

| axis | frustrated | angry | angry / frustrated |
|---|---|---|---|
| eye width | −1.0 | −1.8 | **1.8×** |
| mouth depth | +2.3 | +3.8 | **1.7×** |
| brow rise | +2.7 | +4.2 | **1.6×** |

**Angry is ~1.6–1.8× frustrated along all three shared axes, and adds no fourth.** That
is the honesty constraint in a form that can fail: past roughly 2.5× the avatar begins
asserting a confidence 6/15 accuracy does not support, and under roughly 1.2× the two
states stop being tellable apart. The same table is duplicated in a comment beside the
values in `Avatar.css`, because that is the file someone edits in Phase 5 without having
read this document. The debug grid prints these numbers directly — re-measure after any
change to the state values rather than judging by eye.

This is the visual counterpart of what the per-category regression floors did for model
accuracy in Phase 3: it converts a principle into an assertion that can be violated
detectably.

Two supporting decisions follow from the same reasoning:

**Never show a mood state without real backing data.** `analysis_status="failed"`, a
null `mood`, an unrecognised `mood` string, and a message that has not been analysed all
render `idle`. `idle` is the honest choice for "nothing known" because it is also the
`calm` state — the avatar's resting face carries no claim.

**No confidence display.** Showing "72% angry" would be worse than the current design,
not better: the pipeline emits no per-message confidence, so any number would be
invented, and `toxicity_score`/`heat_score` are intensity signals rather than certainty
in the mood label.

---

## Step 1 — animation approach: hand-drawn SVG + CSS transitions

**Decision: a single inline SVG character whose expression is driven by CSS custom
properties and CSS transitions/keyframes. No new runtime dependency.**

The brief proposed choosing between extending Framer Motion and adding Lottie, on the
premise that Framer Motion is already a project dependency. **It is not** —
[`frontend/package.json`](../frontend/package.json) lists exactly `react` and
`react-dom` in `dependencies`, with Tailwind, Vite and TypeScript as dev dependencies.
So the real comparison is *two* new runtime dependencies against zero, and the brief's
own stated preference — avoid new heavy dependencies if avoidable — resolves to CSS once
the premise is corrected. The work this phase actually needs is a crossfade between five
expressions of one character plus a slow idle motion: five discrete states, no gesture
handling, no layout animation, no spring physics, no timeline scrubbing, which is the
part of the problem Framer Motion exists to solve and none of it applies here.
`transition` on `transform`, `fill`, `opacity` and a couple of `@keyframes` loops cover
it, run on the compositor, and cost nothing to ship. Lottie is the weakest option
regardless of dependency cost: a JSON-baked After Effects export is opaque to review, and
Step 4's constraint is specifically that the `angry` and `frustrated` assets must stay
visually comparable — a property that is much easier to hold when both are hand-authored
SVG differing by a few named values than when both are exported blobs. The revisit
trigger, stated so this isn't a one-way door: if the state transitions measurably drop
frames in Step 5's profiling, Framer Motion goes in for the crossfade specifically, and
that decision gets recorded here with the profiler output that forced it.

A secondary benefit worth naming: driving expression through CSS custom properties on one
shared `<svg>` means the five states are literally the same character by construction —
the geometry is defined once, and the states differ only in the values fed to it. The
"same base character, varying only expression" requirement is enforced structurally
rather than by discipline.

`prefers-reduced-motion: reduce` disables the idle loop and shortens transitions to a
plain opacity change. An expressive avatar is exactly the kind of ambient motion that
setting exists for.

---

## Step 5 — measured performance, and what it settles

Three runs, each a 6.4s window in headless Chrome against the real backend. React commit
cost for the avatar subtree comes from React's own Profiler API; frame intervals come
from `requestAnimationFrame`, because a cheap commit can still drop frames if the
transition forces paint. The third run repeats the send burst with
`prefers-reduced-motion: reduce` emulated, which collapses the CSS transitions to 1ms
while leaving every React render identical — an ablation that isolates animation cost
from render cost.

| | idle control, 0 sends | **5 sends, transitions on** | 5 sends, transitions off |
|---|---|---|---|
| React commits | 1 | 21 | 21 |
| commit median | 2.500 ms | **0.400 ms** | 0.300 ms |
| commit p95 | — | 1.800 ms | 1.300 ms |
| commit max | 2.500 ms | 2.900 ms | 3.700 ms |
| frames observed | 362 | 356 | 366 |
| median frame interval | 16.70 ms | **16.70 ms** | 16.70 ms |
| p95 frame interval | 16.80 ms | **33.30 ms** | 16.80 ms |
| max frame interval | 50.0 ms | 50.1 ms | 66.6 ms |
| intervals > 33 ms | 7 | 20 | 12 |
| long tasks > 50 ms | 0 | 0 | 1 |

**Render cost is negligible.** 0.400ms median per commit against a 16.7ms frame budget,
worst single commit 2.9ms. The avatar is not an expensive component.

**The animation cost is real but small, and it is paint, not React.** p95 frame interval
doubles from 16.8ms to 33.3ms — but only in the middle column. The right-hand run does
the same 21 commits with the same data and returns to 16.8ms, so the extra frame time is
the CSS transitions themselves, not React re-rendering. The likely mechanism is that
`fill` and `stroke` interpolation forces a repaint each frame, unlike `transform` and
`opacity`, which the compositor handles.

**This closes the Framer Motion revisit trigger from Step 1.** That trigger said: adopt
Framer Motion if the transitions measurably drop frames. They measurably do, marginally
— and the measurement also shows Framer Motion would not fix it, because the cost is not
React overhead. Adding an animation runtime on top of an identical repaint would make
this strictly worse. The trigger is answered rather than merely unfired.

**Verdict: acceptable, no change.** Median frame interval is an unbroken 16.70ms across
all three runs, no long task is attributable to the transitions, and max interval is no
worse than idle. The effect is confined to p95 during the 220ms transition windows,
under 5 sends in 6.4s — a far heavier rate than a person typing — in a software-rendered
`--disable-gpu` headless browser, which is pessimistic against real GPU compositing.

If p95 ever does need to come down, the fix is to stop interpolating `fill`/`stroke` and
cross-fade two pre-tinted layers with `opacity` instead, which the compositor can run off
the main thread. Not done here: it doubles the rendered geometry to buy back a cost that
does not currently show.

---

## Known gap this phase inherits

Step 6 adds a client-side timeout that reverts `analyzing` to `idle` after 3s. That is
not a hypothetical safety net. The backend guarantee is sound —
[`worker.py`](../backend/app/worker.py) documents that every path ends `complete`,
`analyze_multilingual` cannot raise, and `failed` is reachable only if the database write
itself fails — but the **frontend** has a real hole: in `pollAnalysis`, a thrown request
error `return`s out of the poll loop without rescheduling and without changing
`analysisStatus`, so a single failed fetch leaves the message `pending` forever. Today
that is invisible, because nothing renders `pending`. The avatar would render it as a
spinner that never stops. The Step 6 timeout is therefore a fix for a real defect this
phase would otherwise expose, and it belongs in the avatar rather than in the poll loop
only because Phase 4 is scoped to presentation — the poll loop's own retry behaviour is
worth revisiting separately.

---

## Definition of done for Phase 4

- [x] Five states render, verified side by side in one screenshot (Step 2) —
  `docs/phase4-step2-states.png`.
- [x] The avatar changes state from **real polled pipeline output** on a real send, with
  the returned `mood` logged alongside the visual (Step 3) —
  `docs/phase4-step3-live.png`, three moods, all `analysis_source=multilingual_local`.
- [x] The `angry`/`frustrated` restraint is documented at the point of definition in the
  component (Step 4) — on the `angry` block in `Avatar.css`, with the measured ratio
  table beside it.
- [x] Transition cost is measured, not asserted (Step 5) — 0.400ms median commit; the
  reduced-motion ablation attributes the p95 frame cost to paint rather than React.
- [x] A delayed or failed analysis lands on `idle`, never an endless spinner (Step 6) —
  `docs/phase4-step6-timeout.png`. Verified against the **real** failure (non-allowlisted
  origin, genuine CORS rejection), not a mock: `analyzing` at +2849ms, `idle` by +3364ms.
  A real result arriving late (+4013ms, `mood=frustrated`) leaves the avatar on `idle`,
  and the very next message animates normally — the deadline latch is per-message.
- [ ] `docs/progress.md` records that this phase added no detection logic (Step 7).
