# Phase 3 — results

Measured output for the multilingual (English / Hindi / Hinglish) analysis path.
Scope and the Gemini-free architecture decision are in [`phase3-scope.md`](phase3-scope.md).

**Last updated:** 2026-07-27

---

## Step 1 — model selection

### Chosen: `cardiffnlp/twitter-xlm-roberta-base-sentiment`

XLM-RoBERTa-base (278M params), fine-tuned for 3-class sentiment
(`negative` / `neutral` / `positive`) on ~198M tweets across eight languages —
**Hindi among them**, alongside Arabic, English, French, German, Italian, Spanish and
Portuguese.

Why this one:

- **Devanagari is native to the tokenizer, not approximated.** XLM-R's 250k
  SentencePiece vocabulary tokenizes Hindi at word level with **zero UNK tokens**:
  `['▁तुम', '▁हमेशा', '▁मेरी', '▁बात', '▁अन', 'सु', 'नी', '▁कर', '▁देते', '▁हो']`
- **Hinglish is in-distribution rather than an accident.** Romanized Hindi resolves to
  real vocabulary entries — `['▁tum', '▁ham', 'esha', '▁meri', '▁baat', '▁ignore',
  '▁kar', '▁de', 'te', '▁ho']`. `▁tum`, `▁meri`, `▁baat` and `▁kar` being single
  tokens means romanized Hindi appeared in XLM-R's CommonCrawl pretraining. This is
  the single most important property for the Hinglish mode, and it is the one the
  rejected candidates fail on.
- **Twitter fine-tuning matches the domain.** Short, informal, punctuation-heavy,
  code-switched messages — which is what a chat app receives.
- **License:** the model card declares none, but the originating repo
  [cardiffnlp/xlm-t](https://github.com/cardiffnlp/xlm-t) is **Apache-2.0**. Recorded
  as a residual ambiguity, not a clean answer — see the caveat below.
- Free, open-weight, runs on CPU. No API key, no billing, no credit card.

### Rejected candidates

| Candidate | License | Why rejected |
|---|---|---|
| `tabularisai/multilingual-sentiment-analysis` | **cc-by-nc-4.0** | The NonCommercial clause is the blocker — it would restrict StillWithYou permanently if it ever ships. Technically attractive otherwise: 135M params (~540MB, ~2× faster than XLM-R base) and a 5-class scale that maps onto calm/neutral/frustrated/angry with no derivation. But its Hindi coverage is inherited from mBERT pretraining, with no Hindi-specific fine-tuning claimed, and 23 declared languages is breadth we explicitly do not want. |
| `pascalrai/hinglish-twitter-roberta-base-sentiment` | mit | **Cannot read Devanagari at all.** Built on English `roberta-base`, whose byte-level BPE has no Devanagari coverage — Hindi-script input degrades to byte fallback. It is Hinglish-specialised, which is tempting, but Step 0 requires all three modes from one analyzer. Also thinly validated: 23 downloads/30d, self-reported F1 0.74 on a machine-translated dataset. |
| `textdetox/xlmr-large-toxicity-classifier` | openrail++ | **Binary `toxic`/`neutral` only** — it cannot produce the four-level mood scale Step 4 grades on, and collapsing calm vs neutral would forfeit two of the four labels. Explicit Hindi coverage (9 languages) and a clean permissive license make it the best *toxicity-only* option; kept on file as a possible second-opinion signal, not as the primary. Also the largest and slowest of the three. |

### Caveat worth carrying forward

The chosen model's HF card states no license. The Apache-2.0 finding comes from the
authors' source repo, not the model card itself, so this is an inference rather than a
declaration. It does not block a personal, non-commercial build. If StillWithYou ever
goes commercial, resolve it then — the openrail++ `textdetox` model is the pre-vetted
swap.

### Measured numbers — real, from this session

Hardware: the same Windows laptop running Postgres, Redis, uvicorn and the ARQ worker.
`torch 2.13.0+cpu`, capped at 4 threads.

| Metric | Value |
|---|---|
| Disk size | **1117.3 MB** (fp32 `pytorch_model.bin` + SentencePiece vocab) |
| Cold load, from disk, fresh process | **8.22s** |
| First inference after load | **469.6 ms** (one-off graph warm-up) |
| Inference latency, n=20 | **median 40.0 ms**, min 27.8, p95 49.4, max 56.1 |

**No ONNX conversion.** Step 1 said measure before assuming. A 40ms median against
Phase 2's 1410ms healthy-Gemini median is ~35× faster than the path it replaces, and
sits between the cache hit (1.085ms) and anything a user would notice. Converting
would add a build step and a second copy of the weights to save tens of milliseconds
inside a job that is already asynchronous. Revisit only if p95 moves past ~250ms.

The 469.6ms first call is why `warm()` exists and is called at worker startup — the
same lesson Phase 2 learned when a cold Gemini client blocked the event loop.

### Step 1 DONE WHEN — pasted output

```
model:      cardiffnlp/twitter-xlm-roberta-base-sentiment
cold load:  8.22s (from disk, fresh process)
disk size:  1117.3 MB
torch:      2.13.0+cpu, threads=4

[EN] You never listen to me. I'm honestly done trying to explain this.
  -> mood=angry  toxicity=0.61  heat=0.72  source=multilingual_local  (469.6 ms)
  -> rewrite: This reads as a verdict rather than a complaint — 'never' turns one
     moment into a pattern. Try naming the single thing that happened and how it felt.

[HI] तुम हमेशा मेरी बात अनसुनी कर देते हो। मैं थक गई हूँ अब समझाते समझाते।
  -> mood=frustrated  toxicity=0.55  heat=0.66  source=multilingual_local  (51.6 ms)
  -> rewrite: This reads as a verdict rather than a complaint — 'हमेशा' turns one
     moment into a pattern. Try naming the single thing that happened and how it felt.

[HINGLISH] tum hamesha meri baat ignore kar dete ho, seriously main thak gayi hu ab
  -> mood=frustrated  toxicity=0.35  heat=0.47  source=multilingual_local  (69.5 ms)

[EN-calm] Thanks for picking up the groceries today, that really helped.
  -> mood=calm  toxicity=0.0  heat=0.0  source=multilingual_local  (54.9 ms)

--- latency, 20 calls (alternating en/hi/hinglish) ---
  n=20  min=27.8ms  median=40.0ms  p95=49.4ms  max=56.1ms
```

The English and Hindi strings carry the same complaint ("you never listen, I'm tired of
explaining") and both land negative with a similar heat score, which is the behaviour
the phase needs. Note the Hindi one is graded `frustrated` where the English is
`angry` — the two are not scored identically, and whether that is a real difference in
the messages or a Hindi-side weakness is exactly what Step 4 measures rather than
assumes.

---

## Step 2 — test corpus

30 hand-written messages in
[`backend/tests/fixtures/multilingual_samples.json`](../backend/tests/fixtures/multilingual_samples.json),
10 per language, spanning friends, roommates, siblings, classmates, colleagues and
family — not couples. All 30 texts are distinct.

### Limitations that constrain how the Step 4 numbers may be read

These are properties of the corpus, not of the model. They are recorded here so the
per-language comparison is not read as more precise than it is.

**Cross-language content is not controlled.** Only `en-09` and `hinglish-10` are near
parallels (the same betrayed-confidence situation). Elsewhere the categories are
thematically similar but not the same message translated: `en-07` is a sink, `hi-07` is
dishes, `hinglish-07` is a light left on. Consequence: **if Hindi scores worse than
English on `frustrated`, this corpus cannot distinguish a genuine language-capability
gap from the Hindi example simply being milder.** Any such gap is a hypothesis to
investigate, not a finding.

**Severity is not calibrated across languages.** The English angry items use blunt
insults (`pathetic`, `you always do this`); the Hindi ones use `तमीज़ नहीं है` and
`बकवास`. Both are real anger markers, but translation-equivalent intensity is
inherently fuzzy and cannot be fixed by rewriting. A Hindi-vs-English accuracy gap may
partly be an artifact of the two languages' angry examples not being equally angry.

**n=2 per language for `frustrated` and `angry`.** One wrong call moves a category
accuracy by 50 percentage points. These are the two categories the product exists to
detect, and at n=2 their per-language accuracies are closer to noise than measurement.

**Four fixtures contain vocabulary from the analyzer's own escalation lexicon**
(`pathetic`, `बकवास`, `bakwas`, `bewakoof`) — see the measurement-validity section
below.

**No sarcasm or manipulation-pattern examples**, per the scope boundary in
[`phase3-scope.md`](phase3-scope.md).

---

## Measurement validity — what the 4-way mood accuracy actually tests

The chosen model emits **3 classes** (`negative`/`neutral`/`positive`); the corpus is
labelled with **4 moods**. The gap is closed by `_mood()`, which splits `negative` into
`frustrated` vs `angry` using a hand-written escalation lexicon and three thresholds
(`insult >= 0.7`, `p_neg >= 0.80`, `toxicity >= 0.6 and heat >= 0.6`). **Those
thresholds were chosen by feel before the corpus existed and have not been validated
against anything.**

Measured across all 30 fixtures (`scripts/diagnose_mapping.py`):

| What decided the mood label | Count |
|---|---|
| The model | 24/30 |
| The hand-written lexicon | 4/30 |
| The unvalidated thresholds | 2/30 |

**Model-only polarity accuracy (negative vs not-negative): 28/30.** This is the honest
measure of the model itself, independent of the mapping, and it should be reported
alongside any 4-way number.

### Two concrete distortions found

**The `p_neg >= 0.80` threshold produces a wrong answer on `en-08`.** The model
classified it `negative` at `p_neg=0.84` — correct. The threshold then promoted it to
`angry` against a `frustrated` label. The fixture fails on a number that was invented,
not on anything the model got wrong.

**The lexicon conceals a genuine Hinglish weakness.** Four `angry` fixtures contain
words from the analyzer's own lexicon, and all four were decided by lexicon lookup
rather than by the model:

| fixture | lexicon term | model's own `p_neg` |
|---|---|---|
| en-09 | `pathetic` | 0.96 — model agrees |
| hi-10 | `बकवास` | 0.82 — model agrees |
| hinglish-09 | `bakwas` | 0.50 — model unconvinced |
| hinglish-10 | `bewakoof` | **0.38 — model says not negative** |

With the lexicon disabled, Hinglish `angry` would score **0/2**. The lexicon is
therefore masking exactly the kind of per-language weakness Step 5 exists to find. Any
Step 4 table must report a lexicon-disabled figure next to the headline one, or it will
overstate Hinglish performance.

## Step 3 — language detection

`app/services/language_detect.py`. Three passes: Devanagari Unicode range → romanized
Hindi marker list → `langdetect` for the remainder.

### Result: 45/45

| language | detected correctly |
|---|---|
| `en` | 15/15 |
| `hi` | 15/15 |
| `hi-en-mixed` | 15/15 |
| **total** | **45/45** |

### Why the marker list exists, in numbers

`langdetect` alone scores **30/45**. It is perfect on English and Devanagari Hindi and
scores **0/15 on Hinglish** — it never once returned `hi` for romanized Hindi, guessing
Indonesian, Estonian, Tagalog, Italian and Swahili instead:

```
hinglish-01  langdetect=id    hinglish-05  langdetect=tl
hinglish-02  langdetect=et    hinglish-06  langdetect=it
hinglish-04  langdetect=id    hinglish-09  langdetect=sw
```

Romanized Hindi is not among its 55 language profiles, so in Latin script it reads as
misspelled European text. The marker list is not a refinement of `langdetect`; it is
the only thing doing the Hinglish work.

### 45/45 is not as strong as it looks — held-out check

The marker list was written after the fixtures and by the same author, so a perfect
fixture score partly measures memorisation. It was therefore re-run against six **real
messages** between Ananya and their friends, supplied verbatim and not consulted while
building the list — including three English messages with informal markers (`bro`,
`bae`, `Ik`) as false-positive traps:

```
[OK] hi-en-mixed  oh abhi matlab mattress nhi layi h tU, nhi saaf hoga dhange se...
                  markers (13): aaj, abhi, aur, ek, h, hoga, hogi, jana, ke, matlab, nhi, se, tu
[OK] hi-en-mixed  Ik you guys did your best, koi baat nhi next drive me ho Jayega
                  markers (5): baat, ho, jayega, koi, nhi
[OK] hi-en-mixed  all the best to CRED wale sorry mai so rhi thi pehle wish nhi kar paayi
                  markers (5): kar, mai, nhi, rhi, thi
[OK] en           all the best bro for tomorrow, that role is just for you...
                  markers (0): []
[OK] en           May you have the best year of your life ahead...
                  markers (0): []
[OK] en           Not so perfect but so beautiful...
                  markers (0): []

=== held-out detection: 6/6 ===
```

Zero markers on all three English messages, so the false-positive risk is real but not
realised. This is the number to trust more than 45/45.

---

## Step 4 — baseline accuracy

45 fixtures through `analyze_multilingual()`. Exact match only — no partial credit.

### Full table

| id | expected | model mood | toxicity | heat | correct? |
|---|---|---|---|---|---|
| en-01 | calm | calm | 0.01 | 0.01 | YES |
| en-02 | calm | calm | 0.00 | 0.00 | YES |
| en-03 | calm | neutral | 0.05 | 0.04 | NO |
| en-04 | neutral | neutral | 0.04 | 0.04 | YES |
| en-05 | neutral | neutral | 0.24 | 0.22 | YES |
| en-06 | neutral | neutral | 0.02 | 0.02 | YES |
| en-07 | frustrated | frustrated | 0.50 | 0.47 | YES |
| en-08 | frustrated | angry | 0.59 | 0.55 | NO |
| en-09 | angry | angry | 0.85 | 0.77 | YES |
| en-10 | angry | angry | 0.58 | 0.69 | YES |
| en-11 | frustrated | frustrated | 0.54 | 0.50 | YES |
| en-12 | frustrated | frustrated | 0.53 | 0.49 | YES |
| en-13 | angry | neutral | 0.12 | 0.12 | NO |
| en-14 | angry | angry | 0.56 | 0.52 | YES |
| en-15 | angry | frustrated | 0.50 | 0.47 | NO |
| hi-01 | calm | calm | 0.02 | 0.09 | YES |
| hi-02 | calm | calm | 0.10 | 0.09 | YES |
| hi-03 | calm | calm | 0.16 | 0.15 | YES |
| hi-04 | neutral | neutral | 0.19 | 0.17 | YES |
| hi-05 | neutral | neutral | 0.03 | 0.03 | YES |
| hi-06 | neutral | neutral | 0.10 | 0.09 | YES |
| hi-07 | frustrated | frustrated | 0.50 | 0.61 | YES |
| hi-08 | frustrated | neutral | 0.24 | 0.23 | NO |
| hi-09 | angry | frustrated | 0.31 | 0.28 | NO |
| hi-10 | angry | angry | 0.70 | 0.68 | YES |
| hi-11 | frustrated | frustrated | 0.40 | 0.38 | YES |
| hi-12 | frustrated | frustrated | 0.33 | 0.30 | YES |
| hi-13 | angry | frustrated | 0.29 | 0.27 | NO |
| hi-14 | angry | frustrated | 0.34 | 0.31 | NO |
| hi-15 | angry | frustrated | 0.40 | 0.37 | NO |
| hinglish-01 | calm | calm | 0.23 | 0.22 | YES |
| hinglish-02 | calm | calm | 0.16 | 0.15 | YES |
| hinglish-03 | calm | calm | 0.04 | 0.03 | YES |
| hinglish-04 | neutral | neutral | 0.17 | 0.16 | YES |
| hinglish-05 | neutral | neutral | 0.24 | 0.22 | YES |
| hinglish-06 | neutral | neutral | 0.21 | 0.19 | YES |
| hinglish-07 | frustrated | calm | 0.24 | 0.22 | NO |
| hinglish-08 | frustrated | frustrated | 0.32 | 0.45 | YES |
| hinglish-09 | angry | angry | 0.70 | 0.48 | YES |
| hinglish-10 | angry | angry | 0.85 | 0.40 | YES |
| hinglish-11 | frustrated | frustrated | 0.29 | 0.27 | YES |
| hinglish-12 | frustrated | frustrated | 0.29 | 0.26 | YES |
| hinglish-13 | angry | neutral | 0.23 | 0.21 | NO |
| hinglish-14 | angry | frustrated | 0.26 | 0.24 | NO |
| hinglish-15 | angry | frustrated | 0.30 | 0.28 | NO |

### Accuracy per category

| language | 4-way (shipped) | 4-way, lexicon off | polarity (model only) |
|---|---|---|---|
| `en` | **11/15** | 11/15 | 14/15 |
| `hi` | **10/15** | 10/15 | 14/15 |
| `hi-en-mixed` | **11/15** | 9/15 | 13/15 |
| **total** | **32/45** | 30/45 | **41/45** |

### The finding: the weak category is not a language, it is `angry`

| mood | correct |
|---|---|
| calm | 8/9 |
| neutral | 9/9 |
| frustrated | 9/12 |
| **angry** | **6/15** |

Per-language accuracy is essentially flat (11 / 10 / 11). The real weakness is
orthogonal to language and would have been invisible in a per-language table alone.

Confusion, over all 13 misses:

```
angry      -> frustrated  7
angry      -> neutral     2
calm       -> neutral     1
frustrated -> angry       1
frustrated -> neutral     1
frustrated -> calm        1
```

**Nine of thirteen misses are `angry` scored too low.** The cause is visible in the
`p_neg` column: the model reliably detects *negativity* (41/45 polarity) but the
frustrated→angry promotion depends on `p_neg >= 0.80`, and cold anger does not produce
high negative probability. Withdrawal and refusal — the way anger is most often
actually expressed between people who are not shouting — sit at `p_neg` 0.18–0.57:

| fixture | text | p_neg | got |
|---|---|---|---|
| en-13 | Don't bother explaining. I heard exactly what you said about me. | 0.18 | neutral |
| en-15 | Forget it. I'm done asking you for anything. | 0.72 | frustrated |
| hi-15 | छोड़ो। अब तुमसे कुछ माँगना ही नहीं है मुझे। | 0.57 | frustrated |
| hinglish-13 | Rehne de, safai mt de. Maine khud suna h tune mere baare me kya bola. | 0.32 | neutral |
| hinglish-15 | Chhod de. Ab tujhse kuch maangna hi nhi h mujhe. | 0.43 | frustrated |

This is a real product finding, not a scoring artifact: **a sentiment model measures
polarity, and cold contempt is not linguistically negative.** `en-08` is the mirror
image — the model was right (`negative`, `p_neg=0.84`) and the 0.80 threshold wrongly
promoted it to `angry`.

### What the corpus expansion bought

The earlier 30-message corpus scored 25/30 (83%) with `angry` at 4/6. Adding five
lexicon-free heated messages per language dropped `angry` to 6/15 and total accuracy to
71%. **The lower number is the more honest one.** The first corpus' `angry` items
mostly contained insults from the analyzer's own lexicon, so they were graded by
keyword lookup; once anger had to be inferred from tone alone, the capability was not
there.

The lexicon-disabled column isolates this. Turning the lexicon off changes exactly two
answers, both Hinglish, both from correct to wrong:

```
hinglish-09  expected angry  with-lex angry  without-lex frustrated  p_neg=0.50
hinglish-10  expected angry  with-lex angry  without-lex frustrated  p_neg=0.38
```

So `hi-en-mixed` reads 11/15 shipped but **9/15 on the model's own merits**, and it is
the only language whose headline number depends on the lexicon. English and Hindi are
unaffected — their scores are the model's.

### Against Step 10's bars — per-category floors

The regression test originally asserted a single aggregate (32/45) with zero margin.
That was the wrong shape of guard in two ways: it could not distinguish *"the analyzer
got strictly worse"* from *"one category traded against another"*, and when it failed it
said nothing about **which** capability broke — the only thing a failure needed to
communicate. It has been replaced with per-category floors.

| category | measured | floor | margin | reasoning |
|---|---|---|---|---|
| `calm` | 8/9 | 7/9 | +1 | floor at measured−1: catches regression while tolerating normal fixture-level noise |
| `neutral` | 9/9 | 8/9 | +1 | floor at measured−1; the only category at 100%, so this margin is its entire tolerance |
| `frustrated` | 9/12 | 8/12 | +1 | floor at measured−1: catches regression while tolerating normal fixture-level noise |
| `angry` | 6/15 | **6/15** | **0** | floor at measured exactly — the known-weak category has nothing left to give away |
| **overall** | 32/45 | 30/45 | +2 | secondary backstop, see below |
| language detection | 45/45 | 39/45 | +6 | unchanged, 87% restated from Step 10's 26/30 |

**`angry` has no regression margin by design — any further drop is a real signal, not
noise, and should block a merge.**

### Why overall is 30, not 32 or 29

The four category floors sum to 29. The overall floor is set at **30** because both
neighbouring values would make it useless:

- **At 32** (the measured total) the aggregate binds before any category floor can fire.
  A single `calm` regression — explicitly permitted by its own 7/9 floor — would leave
  31/45 and fail anyway. Every per-category margin would be nullified, reinstating the
  zero-margin brittleness this redesign exists to remove.
- **At 29** (the exact sum of the floors) it is arithmetically incapable of failing
  unless a category floor has already failed. Pure redundancy.

At 30 it does a job nothing else here can: catching **broad shallow degradation**, where
several categories each slip just inside their own floor and no single assertion
notices. One category regressing leaves 31 (passes); two leaves 30 (passes); three
leaves 29 (fails).

### The two layers catch different things — demonstrated, not asserted

A deliberate regression was injected into the analysis path (forcing `hi-10`, expected
`angry`, to return `frustrated`) to verify the test actually fails rather than merely
currently passing:

```
    calm         8/9   floor 7/9   margin +1
    neutral      9/9   floor 8/9   margin +1
    frustrated   9/12  floor 8/12  margin +1
    angry        5/15  floor 6/15  margin -1     <- caught
    OVERALL     31/45  floor 30/45 margin +1     <- PASSED

E   AssertionError: angry accuracy 5/15 fell below floor 6/15 - regression in
    low-affect anger detection (this category has zero margin by design).
```

**The aggregate passed.** A real regression in the single capability this product exists
to detect slipped past the overall backstop, and only the category floor caught it. Had
the test been aggregate-only, this would have shipped. The injection was then reverted
and the clean run restored to 10 passed, 32/45.

### Caveat: this test cannot tell a fixture change from a code regression

These floors assume `backend/tests/fixtures/multilingual_samples.json` is unchanged. If
the test fails immediately after that file is edited — fixtures added, removed or
relabelled — that is most likely a **fixture change, not a model or code regression**.
Re-baseline the floors against the new fixture set rather than treating the failure as a
regression. Nothing in the test can distinguish the two causes, so the judgement has to
be made by whoever edited the fixtures.

The same caveat is repeated as the module docstring of
`tests/test_multilingual_regression.py`, so it is visible at the point of failure as
well as here.

### On reporting these numbers

Mood accuracy is **32/45 (71.1%)**, which clears the 70% threshold by roughly one
percentage point. It should not be reported as "passes" or "✅" without that qualifier,
in this document, in `progress.md`, in a CV, or in an application. "Meets the threshold"
and "meets the threshold narrowly" answer a follow-up question very differently, and the
second is what is true here.

The bars were restated from Step 10's original `/30` form when the corpus grew from 30
to 45 fixtures. The percentages are unchanged (87% and 70%); they were not lowered.

## Step 5 — iteration

### Pre-registered before the experiment was run

This section was written and the pass criterion fixed **before**
`textdetox/xlmr-large-toxicity-classifier` had finished downloading, and before it was
run on anything. The point is to make the decision falsifiable: the same discipline that
put the fixture labels on paper before the model saw them.

**The gap being addressed.** `angry` scores 6/15. Per-language accuracy is flat
(11/10/11), so the weakness is not Hinglish and code-switch normalisation — Step 5's
other option — cannot address it. English and Hindi fail in the same way for the same
reason.

**The intervention.** Add `textdetox/xlmr-large-toxicity-classifier` (openrail++, 9
languages incl. Hindi) as an independent second signal for the frustrated→angry
boundary only. Chosen because toxicity is conceptually the right axis for that split,
and because it is trained by other people on data this project did not write, so unlike
a re-tuned threshold it cannot overfit this corpus.

**The failure set — the only thing this is meant to fix.** These 9 fixtures are labelled
`angry` and currently score otherwise:

| fixture | expected | currently got | p_neg |
|---|---|---|---|
| en-13 | angry | neutral | 0.18 |
| en-15 | angry | frustrated | 0.72 |
| hi-09 | angry | frustrated | 0.44 |
| hi-13 | angry | frustrated | 0.41 |
| hi-14 | angry | frustrated | 0.48 |
| hi-15 | angry | frustrated | 0.57 |
| hinglish-13 | angry | neutral | 0.32 |
| hinglish-14 | angry | frustrated | 0.37 |
| hinglish-15 | angry | frustrated | 0.43 |

### Go / no-go criterion, fixed in advance

> **Keep the second model only if it turns at least 5 of those 9 into `angry`, without
> breaking any of the 6 `angry` fixtures that already pass and without dropping total
> accuracy below 32/45. Otherwise revert it and document `angry` 6/15 as a known
> limitation.**

Judged against the failure set, **not** against overall accuracy. Overall accuracy could
drift up or down for unrelated reasons; this swap is only justified if it fixes the
specific thing it was introduced to fix. The cost being weighed against that is real:
~1.1GB more on disk, roughly 2× inference latency, a second model whose license must be
relied on, and a two-model architecture in place of a one-model one.

### The hypothesis, stated before the result is known

**Prediction: this will fail the criterion.**

Step 1 already rejected this model for this task, on the grounds that binary
toxic/neutral cannot express a 4-level mood scale. Demoting it to a secondary signal
does not retire that objection. And there is a more specific reason to expect failure:
the 9 missed messages are not toxic. "Don't bother explaining", "Rehne de, safai mt de",
"छोड़ो। अब तुमसे कुछ माँगना ही नहीं है मुझे" contain no slur, no harassment, no hostile
content — several are outright polite. A toxicity classifier is trained on slurs,
harassment and hate speech.

Both models may therefore be proxies for the same thing — *loud* negativity — while the
capability actually missing is recognising *quiet, controlled* anger, which trips
neither. If that is right, the second model buys nothing on these 9 and costs 1.1GB.

Recording the prediction in advance so that whichever way it goes, the write-up is not
a story reverse-engineered from the outcome.

### Result: 0/9 — criterion failed, intervention reverted

The prediction held. Not marginally: **zero** of the nine recoverable, against a bar of
five.

`textdetox/xlmr-large-toxicity-classifier` (labels `{0: neutral, 1: toxic}`) scored the
nine missed `angry` fixtures like this:

| fixture | p_toxic | text |
|---|---|---|
| en-13 | **0.000** | Don't bother explaining. I heard exactly what you said about me. |
| en-15 | **0.000** | Forget it. I'm done asking you for anything. |
| hinglish-13 | 0.002 | Rehne de, safai mt de. Maine khud suna h tune mere baare me kya bola. |
| hi-13 | 0.003 | रहने दो, सफाई मत दो। मैंने खुद सुना है तुमने मेरे बारे में क्या कहा। |
| hi-14 | 0.003 | अब तुम्हारा बचाव मैं नहीं करूँगा। अपनी गड़बड़ खुद संभालो। |
| hinglish-14 | 0.007 | Ab teri side mai nhi lunga. Apna mess khud sambhal. |
| hi-09 | 0.069 | मेरी चीज़ें बिना पूछे मत छुआ करो। तुम्हें कोई तमीज़ ही नहीं है। |
| hinglish-15 | 0.420 | Chhod de. Ab tujhse kuch maangna hi nhi h mujhe. |
| hi-15 | 0.485 | छोड़ो। अब तुमसे कुछ माँगना ही नहीं है मुझे। |

Seven of nine sit at or below 0.069. The toxicity model does not merely rank them low —
it considers them **actively non-toxic**.

### Why no threshold could have rescued it

The highest `p_toxic` across every `calm` and `neutral` fixture is **0.542**, so any
threshold at or below that starts mislabelling kind messages. Both of the two
best-scoring missed fixtures (0.485, 0.420) fall *underneath* that ceiling. There is no
cut point that recovers even one of the nine without breaking a calm message first —
which is why this was tested as a ceiling rather than by tuning a threshold and
reporting the best result.

And the fixture setting that ceiling is the finding in miniature:

```
hinglish-01   calm   p_toxic=0.542
  "Thak gyi hogi tu, aaj kuch mat kar, seedha so ja. Baaki kal dekh lenge."
  (you must be tired, don't do anything today, just go to sleep)
```

**A message telling a friend to rest is scored more toxic than every one of the nine
genuinely angry messages.** The two signals are not merely uncorrelated here; on this
corpus they are close to inverted.

### What this establishes

Both models are proxies for **loud** negativity — overt hostility, insult vocabulary,
hostile register. Neither has a representation of **quiet, controlled** anger:
withdrawal, cold refusal, the deliberate withholding of engagement. That is not a defect
in either model, and swapping in a third of the same kind would not fix it. Sentiment
classifiers are trained on polarity; toxicity classifiers are trained on slurs and
harassment. *"Forget it. I'm done asking you for anything"* contains neither, and is
nonetheless one of the more serious things one person can say to another.

The corroborating evidence is in the six fixtures that already pass. Toxicity agrees
with the sentiment model on only three of them (`en-14` 0.999, `hi-10` 0.998,
`hinglish-09` 0.999) — all blunt. On `en-09` (0.003), `en-10` (0.000) and `hinglish-10`
(0.002) it sees nothing at all, including one containing `bewakoof`. It is not a
complementary signal; it is a narrower version of the same one.

### Decision

**Reverted.** The intervention was never integrated — the probe read raw scores before
any wiring was written, so there is no code to remove. `analyze_multilingual` remains a
single-model path, and `textdetox` is not a dependency (absent from `requirements.txt`;
its ~1.1GB cache entry can be deleted). Iteration budget used: **1 of 2**.

`angry` 6/15 stands as a **known limitation**, documented rather than forced. Per Step
5's own instruction, this is the correct outcome when a category stays weak — not
something to be engineered away by tuning against the test set.

### What would actually fix it, for a later phase

Recorded so the gap does not have to be rediscovered. None of these belong in Phase 3:

- **A model trained on interpersonal conflict**, not social-media toxicity. The target
  concept is contempt and withdrawal — closer to Gottman's Four Horsemen than to
  content moderation.
- **Conversational context.** "Forget it" is unremarkable alone and severe as the fourth
  reply in a thread. Every analyzer here scores single messages in isolation, which
  structurally cannot capture escalation.
- **A few-shot LLM prompt**, which is what Gemini would have offered had it been
  reachable — cold contempt is exactly the kind of pragmatic inference a generative
  model handles and a 278M classifier does not.

This is also the honest answer to "why not just use a bigger local model": the gap is
conceptual, not a matter of parameter count.

---

## Step 6 — cache key correctness across scripts

`backend/tests/test_multilingual_cache_keys.py` — 6 passed.

A Devanagari message and its Hinglish transliteration must not share a cache key. They
do not:

```
devanagari  key=swy:analysis:529dc51ba2188c10cb787a04b6d8a6cd
            text=बकवास बंद करो। तुम बिल्कुल बेवकूफ हो।
            mood=angry toxicity=0.85 heat=0.75 source=multilingual_local

hinglish    key=swy:analysis:9ee49e2f742a219666c827d45ef7021a
            text=Bakwas band karo. Tum bilkul bewakoof ho.
            mood=angry toxicity=0.85 heat=0.44 source=multilingual_local

keys equal?                        False
case/space folding still works?    True
```

### The heat scores differ, and that is the actual justification

Both land on `angry` with identical toxicity, but heat is **0.75 in Devanagari against
0.44 in Hinglish** for the same sentence. So these are not merely two encodings of one
message that happen to hash differently — they are scored differently by the model, and
merging their cache entries would serve a materially wrong answer for one of them.

That converts Step 6 from a hash-property argument into an empirical one. The current
implementation cannot collide, since the key is a SHA-256 over the raw normalized text
and the two scripts are different byte strings. The risk this test actually guards is a
future change: transliteration folding or Unicode compatibility normalisation is exactly
the kind of thing added later to lift the cache hit rate, and either would silently
merge these two. The test fails loudly if that happens.

The folding the cache genuinely depends on is asserted alongside it — case and
whitespace still collapse, because those cannot change an analysis.

---

## Step 7 — wired into the pipeline

`analyze_multilingual()` is the active analyzer in the ARQ job. Gemini remains the
nominal primary: still the branch the circuit breaker guards, still the only thing
recording breaker successes and failures, still consulted first. A single setting gates
it.

```python
# app/core/config.py
# Gemini primary path blocked as of 2026-07-27, see docs/progress.md —
# multilingual_local serving as primary until resolved.
gemini_enabled: bool = False
```

Setting `GEMINI_ENABLED=true` restores Phase 2 behaviour with no code change.

### A production bug the Phase 2 suite caught

```
StringDataRightTruncationError: value too long for type character varying(16)
[parameters: ('complete', 'multilingual_local', 'neutral', 0.17, 0.16, None, ...)]
```

`analysis_source` was `varchar(16)`; `multilingual_local` is 18 characters. This would
have failed on **every message in production**, surfacing as an ARQ job crash and
leaving rows stuck in `pending` — precisely the failure Phase 2 exists to prevent. Fixed
by migration `c7d1a4f92b30` (widened to 32, verified applied). It was invisible to the
fixture scripts, which never touch Postgres; only the tests that use the real database
found it.

### End-to-end evidence

Real messages through the running app, API → ARQ → model → Postgres:

```
HINDI angry    POST 46.4ms | complete 425ms | src=multilingual_local expected=angry  got=angry  [MATCH] tox=0.7  heat=0.68
               अपनी गलती मान लो बस। सारा इल्ज़ाम मुझ पर डालना बंद करो, बकवास लगता है।
HINGLISH angry POST 23.2ms | complete 636ms | src=multilingual_local expected=angry  got=angry  [MATCH] tox=0.7  heat=0.48
               Tu apna kaam kr hi nhi rha aur ulta mujhe hi sunata h. Bilkul bakwas hai ye.
HINDI calm     POST 23.7ms | complete 425ms | src=multilingual_local expected=calm   got=calm   [MATCH] tox=0.16 heat=0.15
               कोई बात नहीं यार, अगली बार हो जाएगा। तुमने पूरी कोशिश तो की थी।
HINGLISH calm  POST 23.0ms | complete 422ms | src=multilingual_local expected=calm   got=calm   [MATCH] tox=0.04 heat=0.03
               Sorry mai so rhi thi, time pe wish nhi kar paayi. But genuinely bhut khush hu tere liye.
```

Worker startup confirms the active path:

```json
{"event": "multilingual_model_loaded", "load_ms": 7078.2}
{"event": "worker_startup", "gemini_enabled": false, "active_analyzer": "multilingual_local"}
```

**Two contaminated runs preceded this one, and are worth recording** because the same
trap will catch the next person. First, a stale ARQ worker from an earlier session was
still consuming the same Redis queue with pre-Phase-3 code, so results came back
`src=gemini`. Second, after killing it, results were *still* `src=gemini` — those were
cache hits serving the contaminated results, visible in the suspiciously fast 215–426ms
completions. Only after `cache.clear()` was the run clean. Both are artifacts of testing
against a live shared queue and cache, not of the code under test.

---

## Step 8 — Devanagari rendering

The font stack in `frontend/src/index.css` had **no Devanagari coverage at all**: Inter,
system-ui, -apple-system, BlinkMacSystemFont and Segoe UI contain no Devanagari glyphs
between them. Hindi did render, but only through the browser's implicit last-resort
fallback — not guaranteed, not consistent across platforms, and tofu on a machine with
no Devanagari font installed.

Now named explicitly, OS-bundled faces only, no webfont:

```css
font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
  'Nirmala UI', 'Noto Sans Devanagari', 'Devanagari Sangam MN', sans-serif;
```

Verified two ways rather than assumed (`scripts/check_devanagari_glyphs.py`):

```
=== font stack coverage, in CSS order ===
  Segoe UI                 installed,  10 Devanagari codepoints in cmap
  Nirmala UI               installed, 128 Devanagari codepoints in cmap
  Noto Sans Devanagari     NOT INSTALLED   (expected — it is the Linux/Android fallback)

=== resolving every character of the test message ===
  मैंने तीन बार बिल के बारे में पूछा, अभी तक कोई जवाब नहीं।
  Segoe UI                 renders  1 chars: ,
  Nirmala UI               renders 24 chars: ंअईकछजतनपबभमरलवहािीूेैो।

  unresolved (would render as tofu): NONE
```

cmap coverage alone is not proof — a font can advertise a codepoint and still draw
broken conjuncts — so the string is also rasterized and inspected:
[`phase3-devanagari-render.png`](phase3-devanagari-render.png). Conjuncts and matras are
correctly formed, and mixed Latin+Devanagari sets on one line.

Note that Segoe UI carries 10 stray Devanagari codepoints, enough to make a naive
"first font with any Devanagari" check pick the wrong face. The check resolves against
the actual test string instead.

---

## Step 9 — observability

`language` label on the Phase 2 analysis metrics, from `/metrics` after a real fixture
run:

```
cache_hit_total{language="en"} 1
cache_hit_total{language="hi"} 2
cache_hit_total{language="hi-en-mixed"} 2
cache_miss_total{language="en"} 1
cache_miss_total{language="hi"} 4
cache_miss_total{language="hi-en-mixed"} 3
analysis_local_total{language="en",mood="angry"} 4
analysis_local_total{language="en",mood="calm"} 2
analysis_local_total{language="en",mood="frustrated"} 4
analysis_local_total{language="en",mood="neutral"} 5
analysis_local_total{language="hi",mood="angry"} 2
analysis_local_total{language="hi",mood="calm"} 4
analysis_local_total{language="hi",mood="frustrated"} 8
analysis_local_total{language="hi",mood="neutral"} 5
analysis_local_total{language="hi-en-mixed",mood="angry"} 3
analysis_local_total{language="hi-en-mixed",mood="calm"} 6
analysis_local_total{language="hi-en-mixed",mood="frustrated"} 5
analysis_local_total{language="hi-en-mixed",mood="neutral"} 4
```

`analysis_local` carries both `language` and `mood`, so the mood distribution is
readable per input mode. That matters here specifically: a single undifferentiated
total is what would have hidden the fact that the `angry` weakness is uniform across
all three languages rather than concentrated in Hinglish.

---

## Step 10 — regression test

`tests/test_multilingual_regression.py`, full corpus through detect → analyze → cache.

```
tests/test_multilingual_regression.py::test_language_detection_meets_bar PASSED
tests/test_multilingual_regression.py::test_mood_accuracy_meets_bar PASSED
tests/test_multilingual_regression.py::test_every_fixture_produced_a_result PASSED
tests/test_multilingual_regression.py::test_cache_round_trips_every_script PASSED
tests/test_multilingual_regression.py::test_no_cache_key_collisions PASSED
tests/test_multilingual_regression.py::test_per_category_scores_are_reported
    calm         8/9   floor 7/9   margin +1
    neutral      9/9   floor 8/9   margin +1
    frustrated   9/12  floor 8/12  margin +1
    angry        6/15  floor 6/15  margin +0
    OVERALL     32/45  floor 30/45 margin +2
    en          mood 11/15
    hi          mood 10/15
    hi-en-mixed mood 11/15
PASSED

10 passed in 20.65s
```

The mood gate is five assertions, not one: a floor per category plus an aggregate
backstop. Each category is a separate test function rather than five asserts in one, so
a run that breaks two capabilities reports both — with a single function the first
failure masks the rest, and naming the broken capability is the whole point.

Floors, reasoning, and the injected-regression proof are in
[Against Step 10's bars](#against-step-10s-bars--per-category-floors) above. `angry`
carries **zero margin by design**; any drop there blocks a merge.
