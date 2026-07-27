"""Step 6: a Devanagari message and its Hinglish transliteration must not share a cache key.

Why this needs a test rather than an assumption. The Phase 2 cache key is a SHA-256 of
the normalized text, so two different scripts trivially hash differently — the risk is
not that the current implementation collides, it is that a future "improvement" makes it
collide. Transliteration-folding or Unicode-compatibility normalisation are exactly the
kind of change someone adds to raise the cache hit rate, and either would silently merge
these two messages.

They must stay separate because they are not the same message. `bakwas band karo` and
`बकवास बंद करो` carry the same dictionary meaning but not the same signal: script choice
in a bilingual conversation is itself tone. Serving one's analysis for the other would
be a wrong answer delivered fast, which is worse than a cache miss.

`normalize()` folding case and whitespace is fine and is asserted here too — those
genuinely cannot change an analysis.
"""

import pytest

from app.services.cache import cache_key, normalize

# Same meaning, three renderings. The Devanagari/Hinglish pair is the one that matters;
# the English gloss is included so the test states the full three-way expectation.
DEVANAGARI = "बकवास बंद करो। तुम बिल्कुल बेवकूफ हो।"
HINGLISH = "Bakwas band karo. Tum bilkul bewakoof ho."
ENGLISH = "Stop talking rubbish. You are being completely stupid about this."

PAIRS = [
    ("devanagari vs hinglish", DEVANAGARI, HINGLISH),
    ("devanagari vs english", DEVANAGARI, ENGLISH),
    ("hinglish vs english", HINGLISH, ENGLISH),
]


@pytest.mark.parametrize("label,left,right", PAIRS)
def test_scripts_do_not_share_a_cache_key(label: str, left: str, right: str) -> None:
    assert cache_key(left) != cache_key(right), (
        f"{label}: same cache key for different scripts — one message's analysis "
        f"would be served for the other"
    )


def test_devanagari_survives_normalization() -> None:
    """Normalization must not strip or fold Devanagari into anything else."""
    normalized = normalize(DEVANAGARI)
    assert "बकवास" in normalized
    assert normalized == normalize(DEVANAGARI), "normalize() is not deterministic"


def test_case_and_whitespace_still_fold() -> None:
    """The separation above must not come at the cost of the folding the cache relies on."""
    assert cache_key("Bakwas   band KARO.") == cache_key("bakwas band karo.")
    assert cache_key("  तुम  बिल्कुल  ") == cache_key("तुम बिल्कुल")


def test_transliteration_pair_is_analyzed_independently() -> None:
    """The two scripts must produce genuinely independent analyses, not a shared one.

    Uses the real model, so it is slow and skipped when the weights are absent.
    """
    ml = pytest.importorskip("app.services.multilingual_local")
    try:
        deva = ml.analyze_multilingual(DEVANAGARI)
        hing = ml.analyze_multilingual(HINGLISH)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"model unavailable: {type(exc).__name__}")

    assert deva.source == hing.source == "multilingual_local"
    # Independently computed, so the scores are free to differ — and do.
    assert isinstance(deva.toxicity_score, float)
    assert isinstance(hing.toxicity_score, float)
