"""Local multilingual analyzer for English, Hindi (Devanagari) and Hinglish.

This is the active analysis path for Phase 3. Gemini is blocked externally (see
`docs/progress.md`), so rather than leave every non-English message to the
English-only lexicon in `local_fallback.py`, analysis runs on an open-weight
classifier downloaded from Hugging Face and executed on CPU in-process.

Model: cardiffnlp/twitter-xlm-roberta-base-sentiment — XLM-RoBERTa-base fine-tuned
for 3-class sentiment on eight languages, Hindi among them. Two properties earn it
the slot over the alternatives: XLM-R's SentencePiece vocabulary covers Devanagari
natively, and the fine-tuning corpus is Twitter, so romanized and code-switched text
is in-distribution rather than an accident. Rejected candidates and the reasoning are
recorded in `docs/phase3-results.md`.

The model returns sentiment, not mood, and sentiment alone cannot separate
"frustrated" from "angry" — both are simply negative. That split, and the toxicity
score, come from combining the model's negative probability with a small
escalation lexicon carrying English, Devanagari and romanized-Hindi terms. The model
decides *whether* a message is negative; the lexicon decides *how hard* it lands.
"""

from __future__ import annotations

import os
import re
import threading
from typing import TYPE_CHECKING

from app.schemas.analysis import AnalysisResult

if TYPE_CHECKING:  # pragma: no cover - import cost is the whole point of deferring
    import torch

MODEL_ID = "cardiffnlp/twitter-xlm-roberta-base-sentiment"

# One process, one copy. Loading costs seconds and ~1.1GB, so it happens once, lazily,
# behind a lock — ARQ runs jobs concurrently and two threads racing the load would
# double the memory for no benefit.
_lock = threading.Lock()
_bundle: tuple[object, object, dict[int, str]] | None = None


def _load() -> tuple[object, object, dict[int, str]]:
    """Load tokenizer + model once. Import inside the function so that merely
    importing this module (as tests and the API do) does not pull in torch."""
    global _bundle
    if _bundle is not None:
        return _bundle
    with _lock:
        if _bundle is not None:
            return _bundle

        # Windows without Developer Mode cannot create the symlinks the HF cache
        # normally uses; the download dies with WinError 1314 halfway through.
        # Copying costs the disk space twice over but is the only thing that works
        # on an unprivileged account.
        os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
        os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        # The box is a laptop also running Postgres, Redis, uvicorn and the worker.
        # Letting torch grab every core makes the whole app stutter for a 30ms task.
        torch.set_num_threads(max(1, min(4, (torch.get_num_threads() or 4))))

        tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
        model = AutoModelForSequenceClassification.from_pretrained(MODEL_ID)
        model.eval()

        # Read the label names off the config rather than hardcoding an order —
        # this checkpoint ships LABEL_0/1/2 in some revisions and named labels in
        # others, and guessing wrong silently inverts every score.
        raw = getattr(model.config, "id2label", {}) or {}
        id2label = {int(k): str(v).lower() for k, v in raw.items()}
        if set(id2label.values()) == {"label_0", "label_1", "label_2"}:
            id2label = {0: "negative", 1: "neutral", 2: "positive"}

        _bundle = (tokenizer, model, id2label)
    return _bundle


def warm() -> None:
    """Force the load now instead of inside the first job. Phase 2 learned this the
    hard way with Gemini: a cold dependency initialised inside a request can block
    for far longer than the work it is doing."""
    _load()


# ---------------------------------------------------------------------------
# Escalation lexicon
#
# Small on purpose. The model handles polarity; these terms only sharpen the
# frustrated/angry boundary and give toxicity a floor when someone is plainly
# insulting rather than merely negative. Each mode is written in the script it
# actually gets typed in.
# ---------------------------------------------------------------------------

_INSULTS_EN = {
    "idiot": 0.9, "stupid": 0.8, "moron": 0.9, "pathetic": 0.85, "useless": 0.8,
    "worthless": 0.9, "disgusting": 0.8, "loser": 0.85, "shut up": 0.8,
    "liar": 0.7, "immature": 0.55, "grow up": 0.7, "your fault": 0.7,
}

_INSULTS_HI = {
    "बकवास": 0.7, "बेवकूफ": 0.85, "मूर्ख": 0.85, "पागल": 0.7, "नफरत": 0.8,
    "बेकार": 0.7, "झूठ": 0.65, "झूठा": 0.75, "चुप": 0.6, "शर्म": 0.6,
    "गलती तुम्हारी": 0.7, "तंग आ": 0.7, "बर्दाश्त नहीं": 0.7,
}

# Romanized Hindi. Spelling is not standardised, so the frequent variants are listed
# rather than normalised — Step 5 measures whether that is good enough.
_INSULTS_HINGLISH = {
    "bakwas": 0.7, "bakwaas": 0.7, "bewakoof": 0.85, "bewkoof": 0.85, "pagal": 0.7,
    "nafrat": 0.8, "bekaar": 0.7, "bekar": 0.7, "jhoot": 0.65, "jhootha": 0.75,
    "jhutha": 0.75, "chup": 0.55, "tang aa": 0.7, "sharam": 0.6,
    "tumhari galti": 0.7, "teri galti": 0.75, "bas karo": 0.6,
}

# Absolutes: the escalation marker that turns a complaint about one event into a
# verdict on the person. Same idea as local_fallback, extended to the other modes.
_ABSOLUTES_EN = {"always", "never", "every time", "constantly"}
_ABSOLUTES_HI = {"हमेशा", "कभी नहीं", "हर बार", "हर वक्त"}
_ABSOLUTES_HINGLISH = {"hamesha", "kabhi nahi", "kabhi nahin", "har baar", "har waqt"}

_WARM_EN = {"thank", "thanks", "love", "appreciate", "sorry", "grateful", "proud", "miss you"}
_WARM_HI = {"धन्यवाद", "शुक्रिया", "प्यार", "माफ", "खुश", "अच्छा लगा", "याद"}
_WARM_HINGLISH = {"shukriya", "dhanyavaad", "pyaar", "pyar", "maaf", "sorry yaar", "khush", "yaad"}

_PROFANITY = {"fuck", "shit", "bitch", "asshole", "bastard", "chutiya", "kamina", "harami"}

_WORD_RE = re.compile(r"[\w']+", re.UNICODE)


def _clamp(value: float) -> float:
    return round(max(0.0, min(1.0, value)), 2)


def _shouting_ratio(text: str) -> float:
    """Fraction of cased letters that are uppercase. Devanagari has no case, so this
    only ever fires on the Latin-script modes — which is correct, not a gap."""
    letters = [c for c in text if c.isalpha() and (c.islower() or c.isupper())]
    if len(letters) < 8:
        return 0.0
    return sum(1 for c in letters if c.isupper()) / len(letters)


def _lexicon_hit(lowered: str, words: set[str], table: dict[str, float]) -> tuple[float, list[str]]:
    score, hits = 0.0, []
    for term, weight in table.items():
        if (term in lowered) if " " in term else (term in words or term in lowered):
            score = max(score, weight)
            hits.append(term)
    return score, hits


def _sentiment(text: str) -> dict[str, float]:
    """Run the model. Returns probabilities keyed by negative/neutral/positive."""
    import torch

    tokenizer, model, id2label = _load()
    encoded = tokenizer(text, return_tensors="pt", truncation=True, max_length=128)
    with torch.no_grad():
        logits = model(**encoded).logits[0]
    probs = torch.softmax(logits, dim=-1).tolist()
    return {id2label.get(i, str(i)): float(p) for i, p in enumerate(probs)}


def analyze_multilingual(text: str, *, use_lexicon: bool = True) -> AnalysisResult:
    """Score one message in English, Hindi or Hinglish.

    Same shape and same contract as `analyze_locally`: it returns an AnalysisResult
    and it does not raise. A model failure degrades to the Phase 2 lexicon rather
    than leaving the row stuck in `pending`.

    `use_lexicon=False` runs the model alone, with the escalation lexicon switched
    off. It exists for measurement, not for production: the lexicon is hand-written
    by the same author as the test corpus, so a headline accuracy number that
    includes it partly measures that author's vocabulary agreeing with itself.
    Reporting both figures keeps the model's real contribution visible — see the
    measurement-validity section of `docs/phase3-results.md`.
    """
    try:
        probs = _sentiment(text)
    except Exception:  # noqa: BLE001 - see docstring: this path must not fail
        from app.services.local_fallback import analyze_locally

        degraded = analyze_locally(text)
        return degraded.model_copy(update={"source": "multilingual_local"})

    p_neg = probs.get("negative", 0.0)
    p_pos = probs.get("positive", 0.0)

    lowered = text.lower()
    words = set(_WORD_RE.findall(lowered))

    insult, hits = 0.0, []
    if use_lexicon:
        for table in (_INSULTS_EN, _INSULTS_HI, _INSULTS_HINGLISH):
            score, found = _lexicon_hit(lowered, words, table)
            insult = max(insult, score)
            hits.extend(found)

        if words & _PROFANITY:
            insult = max(insult, 0.75)
            hits.extend(sorted(words & _PROFANITY))

    absolutes = [
        a for a in (_ABSOLUTES_EN | _ABSOLUTES_HI | _ABSOLUTES_HINGLISH) if a in lowered
    ]
    warm = any(
        w in lowered for w in (_WARM_EN | _WARM_HI | _WARM_HINGLISH)
    )
    shouting = _shouting_ratio(text)
    exclamations = text.count("!")

    # Toxicity: the model's negativity is the base, an explicit insult sets a floor.
    # A negative message is not necessarily a cruel one ("I'm exhausted and sad"),
    # so p_neg alone is deliberately discounted.
    toxicity = max(p_neg * 0.7, insult)
    if warm and not hits:
        toxicity -= 0.15

    # Heat is escalation energy, which is not cruelty: a shouted "I NEVER said that"
    # is hot without being toxic.
    heat = p_neg * 0.65
    heat += 0.15 * min(len(absolutes), 2)
    heat += 0.25 if shouting > 0.6 else 0.0
    heat += min(exclamations, 3) * 0.07
    heat += 0.15 if insult >= 0.7 else 0.0
    if warm:
        heat -= 0.15

    toxicity = _clamp(toxicity)
    heat = _clamp(heat)

    mood = _mood(probs, toxicity, heat, insult)
    return AnalysisResult(
        mood=mood,
        toxicity_score=toxicity,
        heat_score=heat,
        rewrite_suggestion=_suggest_rewrite(mood, absolutes, hits, shouting),
        source="multilingual_local",
    )


def _mood(probs: dict[str, float], toxicity: float, heat: float, insult: float) -> str:
    """Collapse 3-class sentiment plus intensity into the four moods Phase 3 grades on.

    `calm` covers both "warm" and "settled" — the fixture corpus treats a friendly
    message and a placid one as the same thing, because for this app's purpose
    (should you send this?) they are.
    """
    top = max(probs, key=probs.get)

    if top == "negative":
        # The model says negative; intensity decides how far. An outright insult is
        # angry regardless of how confident the classifier was.
        if insult >= 0.7 or probs["negative"] >= 0.80 or (toxicity >= 0.6 and heat >= 0.6):
            return "angry"
        return "frustrated"

    # A non-negative top class can still be wrong about a coldly-worded jab, so let a
    # strong lexicon hit override rather than trusting polarity alone.
    if insult >= 0.8:
        return "angry"
    if heat >= 0.55:
        return "frustrated"
    if top == "positive":
        return "calm"
    return "neutral"


def _suggest_rewrite(
    mood: str, absolutes: list[str], hits: list[str], shouting: float
) -> str | None:
    """Names what made the message land hard. It does not attempt a rephrasing —
    nothing local can rewrite a sentence well, and a bad rewrite is worse than none.
    Kept in English deliberately: this is coaching text for the sender, and adding
    Hindi output would be translation, which Step 0 puts out of scope."""
    if mood in ("calm", "neutral"):
        return None
    if absolutes:
        return (
            f"This reads as a verdict rather than a complaint — {absolutes[0]!r} turns one "
            "moment into a pattern. Try naming the single thing that happened and how it felt."
        )
    if shouting > 0.6:
        return "The all-caps reads as shouting. The same words in lower case will land as firm rather than aggressive."
    if hits:
        return (
            f"The wording around {hits[0]!r} attacks the person rather than the problem. "
            "Try describing the behaviour and its effect on you instead."
        )
    return "This may land harder than you intend. Consider leading with what you need rather than what they did wrong."
