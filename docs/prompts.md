# StillWithYou — prompts

Every prompt in this project, in one place. Two distinct kinds, which are easy to
conflate and should not be:

1. **Product prompts** — text sent to an LLM *by the running application*. These are
   source code. They ship, they affect user-facing output, and changing one changes the
   product's behaviour.
2. **Development prompts** — the briefs used to *build* the project. These are process
   artifacts. They shaped the work but never execute.

**Last updated:** 2026-07-28

---

## Part 1 — Product prompts (live in the application)

### 1.1 Gemini message analysis

**Location:** `backend/app/services/gemini.py`, constant `SYSTEM_INSTRUCTION`
**Status:** wired but **dormant** — `settings.gemini_enabled` is `False` (see
[`progress.md`](progress.md)). This prompt is not currently reaching any user.
**Model:** `gemini-3.5-flash-lite`

```text
You analyse a single chat message sent between two people in a close relationship.
Judge only the message given to you.

Return JSON with exactly these keys:
  mood: one lowercase word for the sender's emotional state (calm, hurt, angry,
warm, anxious, distant, playful, ...)
  toxicity_score: float 0.0-1.0, where 0.0 is kind and 1.0 is abusive
  heat_score: float 0.0-1.0, where 0.0 is cool and 1.0 is an escalated fight
  rewrite_suggestion: a softer rephrasing that keeps the sender's intent, or null
if the message is already kind

Be strict about toxicity: insults, contempt and blame score above 0.6.
```

**Structured output is enforced by schema, not by asking politely:**

```python
_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "mood":               {"type": "STRING"},
        "toxicity_score":     {"type": "NUMBER"},
        "heat_score":         {"type": "NUMBER"},
        "rewrite_suggestion": {"type": "STRING", "nullable": True},
    },
    "required": ["mood", "toxicity_score", "heat_score"],
}
```

**Generation parameters, and why each is what it is:**

| Parameter | Value | Reasoning |
|---|---|---|
| `response_mime_type` | `application/json` | Combined with the schema, removes JSON-parsing failure as a class of error rather than handling it |
| `response_schema` | see above | The model cannot return a shape the caller does not expect |
| `temperature` | `0.2` | Scoring, not composition. The same message should score the same twice |
| `thinking_level` | `"low"` | **Measured, not assumed.** At the default level these prompts ran 6.0–12.6s and blew the 2s SLO on every call, with one 30s timeout. At `low`, the same five prompts hit a **1410ms median, 5/5 under 2s** |
| deadline | `3.0s`, client-side | The API *rejects* server-side deadlines under 10s (*"Manually set deadline 3s is too short"*). 3s is our budget, not theirs, so `asyncio.wait_for` enforces it locally |

**Prompt-engineering decisions worth naming:**

- **"Judge only the message given to you."** Without it the model speculates about
  conversational context it has not been given, and scores a message on an argument it
  invented.
- **"Be strict about toxicity: ... score above 0.6."** An explicit numeric anchor. Without
  it the model clustered almost everything in 0.2–0.4, making the score useless as a
  trigger for any downstream threshold.
- **`rewrite_suggestion: ... or null if the message is already kind.`** Explicitly
  permitting `null` stops the model from inventing improvements to messages that need
  none — which reads as nagging.

---

### ⚠️ 1.2 Two known inconsistencies in this prompt

Both were found while compiling this document. Neither is currently reaching users, since
Gemini is disabled — but both are live bugs the moment `GEMINI_ENABLED=true` is set.

#### (a) The prompt contradicts the project's scoping decision

The prompt says:

> *"a single chat message sent between two people **in a close relationship**"*

StillWithYou explicitly serves **any two people** — friends, roommates, siblings,
classmates, colleagues, family — and *not* specifically partners. This is a deliberate
product decision, recorded in
[`project-overview.md §2`](project-overview.md#2-the-problem), and it caused the Phase 3
test corpus to be rewritten from scratch.

"In a close relationship" primes the model toward an assumed baseline of intimacy. A
blunt message between colleagues would be read against the wrong norm.

**Suggested fix** (not applied — this document is a record, not a change):

```diff
- You analyse a single chat message sent between two people in a close relationship.
+ You analyse a single chat message sent between two people — friends, family,
+ colleagues, housemates or partners. Do not assume closeness or intimacy.
```

#### (b) The two analyzers return incompatible mood vocabularies

| Analyzer | Mood labels |
|---|---|
| Gemini prompt | `calm, hurt, angry, warm, anxious, distant, playful, ...` (open set) |
| `multilingual_local` | `calm, neutral, frustrated, angry` (closed set of 4) |

These overlap on only two labels. **This is not theoretical — it was observed.** During
Phase 3 Step 7 end-to-end testing, a stale worker briefly routed messages to Gemini:

```
HINDI calm     expected=calm  got=warm   src=gemini              [MISS]
HINGLISH calm  expected=calm  got=warm   src=gemini              [MISS]
```

Both were scored correctly by any human reading — Gemini simply used a word the Phase 3
label set does not contain. Consequences if Gemini is re-enabled as-is:

- The Phase 3 regression test's per-category floors would fail immediately, and the
  failure would look like a model regression rather than a vocabulary mismatch.
- Any UI switching on `mood` would encounter unhandled values.
- Historical rows would carry two incompatible label systems in one column.

**Resolution required before `GEMINI_ENABLED=true`:** constrain the Gemini prompt to the
same four labels via an `enum` in the response schema, so the constraint is enforced by
the API rather than requested in prose.

```python
"mood": {"type": "STRING", "enum": ["calm", "neutral", "frustrated", "angry"]},
```

---

### 1.3 The non-prompt analyzers

Recorded here so the inventory is complete: **the currently active analysis path uses no
prompt at all.**

| Analyzer | Mechanism |
|---|---|
| `multilingual_local` | `cardiffnlp/twitter-xlm-roberta-base-sentiment` — a fine-tuned classifier. Input is the raw message; there is no instruction text |
| `local_fallback` | A hand-written lexicon and arithmetic. No model, no prompt |

This matters for cost and threat-modelling: the live path has **no prompt-injection
surface**, because there is no instruction context for user text to escape into. A
classifier consumes the message as data, not as instructions. Re-enabling Gemini
reintroduces that surface.

---

## Part 2 — Development prompts

This project was built through structured, multi-step briefs given to an AI coding agent.
The pattern is consistent enough to be worth recording as methodology.

### 2.1 What is and is not recoverable

**Honest limitation:** only the **Phase 3** briefs are reproduced below, from the session
in which they were issued. The Phase 1 and Phase 2 briefs were issued in earlier sessions
and **are not recoverable from the agent side** — what survives of them is their *output*
(`phase2-slo.md`, the commit history, `progress.md`), not their text.

They are reconstructable only from Ananya's own chat history. Marked here as a gap rather
than filled with a plausible-looking reconstruction, because an invented prompt presented
as a record is worse than an acknowledged absence.

| Phase | Brief text | Outcome artifacts |
|---|---|---|
| Phase 1 | ✗ not recoverable | commits `253aa77`, `6b65866`, `8f23409` |
| Phase 2 | ✗ not recoverable | `phase2-slo.md`, `phase2-runbook.md`, 11 commits |
| Phase 3 | ✓ below | `phase3-scope.md`, `phase3-results.md`, 3 commits |

### 2.2 The brief format that worked

Every Phase 3 brief followed one shape:

```
=== STEP N: <goal> ===
- <specific, checkable instruction>
- <specific, checkable instruction>
DONE WHEN: <concrete evidence required — pasted output, not assertion>

=== CONSTRAINTS ===
- <what must not happen>
```

**The `DONE WHEN` clause is the load-bearing element.** It converts "implement language
detection" into "paste detection output for all 30 next to actual language, report
accuracy as a fraction — no rounding up, no hand-waving mismatches." The first can be
satisfied by code that looks right; the second cannot be satisfied without running it.

### 2.3 Phase 3 opening brief — key clauses

The full brief ran to ~90 lines across 12 steps. The clauses that most shaped the outcome:

```
This phase runs entirely on a free, self-hosted model — Gemini API access is
currently blocked externally (documented in docs/progress.md) and this phase
must not depend on it or require any paid setup.

Each step has a DONE WHEN with concrete, pasted evidence — no step is complete
on assertion alone.
```

```
=== STEP 1 ===
Research 2-3 open-weight multilingual sentiment/toxicity models from Hugging Face
with explicit Hindi/code-mixed support; choose one based on size (must run on CPU
at usable speed), license (free for this use), and model-card evidence of
Hindi/multilingual coverage — name the rejected candidates and why.

Integrate via `transformers`; only convert to ONNX if plain inference is
measurably too slow (measure first, don't assume).
```

```
=== STEP 2 ===
Write 30 messages you write yourself ... assign labels by reading the message
yourself, before running anything, to avoid biasing your own labels.
DONE WHEN: paste full content for review before proceeding.
```

```
=== STEP 5 ===
Max two iteration attempts — if still weak after that, document as a known
limitation rather than forcing it.
```

```
=== STEP 10 ===
If it doesn't hit those bars, report the actual numbers and stop — do not lower
the thresholds to make it pass.
```

```
=== CONSTRAINTS ===
- No paid APIs, no billing setup, nothing requiring a credit card
- Never claim "multi-language support" generically — always name the 3 specific modes
- Do not add languages beyond these 3
```

### 2.4 The mid-flight corrections that changed the work most

The briefs were not one-shot. The highest-value inputs were **corrections during
execution**, each of which invalidated work already done:

**On corpus design** — issued after the first 30 fixtures were submitted for review:

> *"THEY ARE JUST SAME IN DIFFERENT LANGUAGES. ALSO ITS NOT JUST PARTNERS, ITS ANY TWO
> PEOPLE WHOSE COMMUNICATION YOU ARE MANAGING, SO IF YOU FOCUS ONLY ON THOSE ROLES, THE
> MESSAGES WOULD HAVE HIGH EXPECTATIONS OF EMPATHY AND EMOTIONAL ATTACHMENT. ALL THE 30
> NEEDS TO BE DIFFERENT"*

Accompanied by real messages the author had sent friends, which is what established the
correct Hinglish register (`nhi`, `h`, `rhi`, `gyi`) and later served as **held-out
validation data** for the language detector — the only genuinely uncontaminated test set
in the project.

**On measurement validity** — issued before the accuracy run was allowed to proceed:

> *"cardiffnlp/twitter-xlm-roberta-base-sentiment is a 3-class model. Your fixture set has
> 4 mood labels. If that's the case, your frustrated/angry accuracy numbers won't actually
> be testing the sentiment model — they'll be testing wherever you set that threshold ...
> This isn't a fixture problem, it's a measurement-validity problem, and it sits upstream
> of every number you're about to produce."*

This single intervention produced the three-column reporting format, the lexicon-ablation
flag, and the discovery that four `angry` fixtures were being graded by keyword lookup
rather than by the model.

**On pre-registration** — issued before the Step 5 experiment ran:

> *"it's worth trying, but bound it before you run it ... Set the go/no-go criterion now:
> 'if textdetox doesn't correctly flag at least 5 of the 9 currently-missed angry
> examples, revert it and document 6/15 as the known limitation.' Don't judge it on
> overall accuracy — judge it specifically against the failure set you already have."*

**On honest framing:**

> *"'32/45 vs ≥32/45 — clearing by exactly zero margin' is a pass in name only ... it
> should be stated as what it is — a threshold met at the boundary, not comfortably
> cleared."*

### 2.5 Prompting patterns that produced good work

Generalisable beyond this project:

| Pattern | Effect |
|---|---|
| **Require pasted evidence, not assertion** | Eliminates plausible-sounding claims about code that was never run |
| **Demand rejected alternatives be named** | Forces genuine comparison rather than picking the first workable option |
| **"Measure first, don't assume"** | Killed a premature ONNX optimisation that would have added a build step to save ~10ms |
| **Cap iterations in advance** | Prevents indefinite tuning against a test set; forces "document the limitation" to be an acceptable outcome |
| **Forbid moving the goalposts** | *"do not lower the thresholds to make it pass"* — the single most important line in the entire brief |
| **Insert review gates mid-task** | *"paste full content for review before proceeding"* — caught the corpus design error before it contaminated four downstream steps |
| **Pre-register experiments** | Criterion and prediction fixed before the result exists, so the write-up cannot be reverse-engineered from the outcome |
| **Correct scope early and bluntly** | The "any two people, not partners" correction reshaped the corpus, the labels, and the product framing |

### 2.6 The anti-pattern this project actually hit

**Building the analyzer before the evaluation corpus.** The escalation lexicon was written
first; the test fixtures were written second, by the same author, and unconsciously reused
the lexicon's vocabulary (`pathetic`, `बकवास`, `bakwas`, `bewakoof`).

The result was four `angry` fixtures graded correct by keyword lookup rather than by the
model, an inflated 83% accuracy figure, and a **concealed Hinglish weakness** — on two of
them the model's own confidence was 0.50 and 0.38, meaning it did not consider them
negative at all.

The fix required rewriting 15 fixtures and adding a `use_lexicon=False` measurement mode.
Corrected accuracy: **71%**.

**The lesson, stated for reuse: write the evaluation set before the thing being
evaluated, or have someone else write it.** Ordering created the contamination; everything
afterwards was cleanup.

---

## Part 3 — Maintenance

**When adding or changing a product prompt:** update Part 1 in the same commit as the code
change. A prompt is behaviour, and an undocumented prompt change is an undocumented
behaviour change.

**Before re-enabling Gemini:** resolve both issues in §1.2. The mood-vocabulary mismatch
will fail the Phase 3 regression test in a way that looks like a model regression, and
that misdiagnosis will cost real time.

**Open item:** the Phase 1 and Phase 2 briefs (§2.1) can be recovered from Ananya's chat
history and pasted in. Until then the record is incomplete, and says so.
