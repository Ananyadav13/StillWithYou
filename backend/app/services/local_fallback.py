"""Lexicon-based analyzer used when Gemini is unavailable.

Deliberately a heuristic and not a model. The job it has to do is narrow: when the
circuit is open, return a same-shaped AnalysisResult in about a millisecond so the
message reaches `complete` instead of sitting in `pending`. A downloaded ONNX
sentiment model would score better on nuance and cost tens of milliseconds plus a
few hundred MB of image size, and would still be wrong about sarcasm. Degraded and
instant beats absent.

What it is good at: catching the blunt, high-signal cases — insults, contempt,
absolutes, shouting — which are exactly the cases where a user most needs the
"you might want to rephrase this" nudge. What it is bad at: subtlety, irony,
context across turns. `source` is always "local_fallback" so a consumer can tell
the difference and treat the score with appropriate suspicion.
"""

import re

from app.schemas.analysis import AnalysisResult

# Weight roughly = "how much does this alone imply the message is hostile".
_TOXIC_TERMS: dict[str, float] = {
    "idiot": 0.9, "stupid": 0.8, "moron": 0.9, "pathetic": 0.85, "useless": 0.8,
    "worthless": 0.9, "disgusting": 0.8, "hate": 0.7, "shut up": 0.8, "loser": 0.85,
    "selfish": 0.6, "lazy": 0.6, "liar": 0.7, "childish": 0.55, "insane": 0.5,
    "ridiculous": 0.5, "annoying": 0.5, "toxic": 0.6, "immature": 0.55,
    "whatever": 0.35, "obviously": 0.3, "grow up": 0.7, "get over it": 0.65,
    "calm down": 0.5, "overreacting": 0.6, "dramatic": 0.5, "your fault": 0.7,
    "blame": 0.5, "fed up": 0.6, "sick of": 0.7, "done with you": 0.8,
}

# Absolutes are the classic escalation marker in conflict research: they convert a
# complaint about one event into a verdict on the person.
_ABSOLUTES = {"always", "never", "every time", "constantly", "nothing but"}

_WARM_TERMS = {
    "thank": 0.5, "thanks": 0.5, "love": 0.5, "appreciate": 0.5, "sorry": 0.4,
    "miss you": 0.5, "please": 0.25, "grateful": 0.5, "proud": 0.4, "happy": 0.4,
    "glad": 0.35, "understand": 0.3, "hear you": 0.4, "my fault": 0.35,
}

_SAD_TERMS = {"alone", "lonely", "hurt", "sad", "scared", "anxious", "afraid", "tired", "exhausted", "overwhelmed"}

_PROFANITY = {"fuck", "shit", "damn", "bitch", "asshole", "bastard", "crap"}

_WORD_RE = re.compile(r"[a-z']+")


def _clamp(value: float) -> float:
    return round(max(0.0, min(1.0, value)), 2)


def _shouting_ratio(text: str) -> float:
    """Fraction of letters that are uppercase, ignoring very short strings."""
    letters = [c for c in text if c.isalpha()]
    if len(letters) < 8:
        return 0.0
    return sum(1 for c in letters if c.isupper()) / len(letters)


def analyze_locally(content: str) -> AnalysisResult:
    """Score one message. Never raises — this is the path that must always work."""
    lowered = content.lower()
    words = set(_WORD_RE.findall(lowered))

    toxicity = 0.0
    hits: list[str] = []
    for term, weight in _TOXIC_TERMS.items():
        if (term in lowered) if " " in term else (term in words):
            toxicity = max(toxicity, weight)
            hits.append(term)

    profanity_hits = words & _PROFANITY
    if profanity_hits:
        toxicity = max(toxicity, 0.75)
        hits.extend(sorted(profanity_hits))

    warmth = 0.0
    for term, weight in _WARM_TERMS.items():
        if (term in lowered) if " " in term else (term in words):
            warmth = max(warmth, weight)

    absolutes = [a for a in _ABSOLUTES if a in lowered]
    shouting = _shouting_ratio(content)
    exclamations = content.count("!")

    # Heat is about escalation energy, which is not the same as cruelty: a shouted
    # "I NEVER said that!" is hot but not especially toxic.
    heat = toxicity * 0.6
    heat += 0.2 * len(absolutes)
    heat += 0.3 if shouting > 0.6 else 0.0
    heat += min(exclamations, 3) * 0.08
    heat -= warmth * 0.4

    # Warmth pulls toxicity down, but cannot fully excuse an insult: "thanks for
    # nothing, idiot" should not read as kind.
    toxicity -= warmth * 0.3
    if absolutes and toxicity > 0:
        toxicity += 0.1

    toxicity = _clamp(toxicity)
    heat = _clamp(heat)

    if toxicity >= 0.6:
        mood = "angry"
    elif heat >= 0.5:
        mood = "frustrated"
    elif words & _SAD_TERMS:
        mood = "hurt"
    elif warmth >= 0.4:
        mood = "warm"
    elif toxicity >= 0.3:
        mood = "distant"
    else:
        mood = "calm"

    rewrite = _suggest_rewrite(toxicity, heat, absolutes, hits, shouting)

    return AnalysisResult(
        mood=mood,
        toxicity_score=toxicity,
        heat_score=heat,
        rewrite_suggestion=rewrite,
        source="local_fallback",
    )


def _suggest_rewrite(
    toxicity: float, heat: float, absolutes: list[str], hits: list[str], shouting: float
) -> str | None:
    """Generic but honest advice. No local heuristic can rephrase a sentence well,
    so it names the specific thing that made the message land hard instead."""
    if toxicity < 0.4 and heat < 0.5:
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
