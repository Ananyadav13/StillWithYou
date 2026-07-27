"""Detect which of the three Phase 3 input modes a message is written in.

    en           English
    hi           Hindi in Devanagari script
    hi-en-mixed  Hinglish — romanized Hindi, usually code-switched with English

Three passes, in this order, because each handles what the previous one cannot:

1. **Devanagari Unicode range.** Decisive and cheap. If the message is written in
   Devanagari it is Hindi, and no statistical model is needed to say so.
2. **A romanized-Hindi marker list.** This is the pass that actually matters, because
   the off-the-shelf detector cannot do the job at all — see below.
3. **`langdetect` as the general-purpose first pass** for everything left over, which
   in practice means separating English from anything that is neither English nor
   Hindi.

**Why the marker list carries the weight.** `langdetect` identifies languages by
character n-grams over a fixed set of 55 profiles. Romanized Hindi is not one of them,
and in Latin script it looks like badly-spelled English, so `langdetect` reports `en`
for nearly every Hinglish message. Treating its answer as authoritative would collapse
`hi-en-mixed` into `en` entirely. It is kept because it is genuinely good at the job it
can do — confirming that English is English — and useless for the one it cannot.

The marker list is function words and common verb stems, which is what survives
code-switching: people swap nouns into English ("meeting", "bill", "drive") while the
grammatical skeleton stays Hindi. It includes the compressed spellings people actually
type — `nhi`, `h`, `rhi`, `kr`, `gyi`, `mt` — because textbook transliteration is not
what arrives. Any token that is also an English word (`main`, `to`, `do`, `par`, `me`,
`band`, `the`) is deliberately excluded, since a false `hi-en-mixed` on plain English
is the more damaging error.
"""

from __future__ import annotations

import re
from typing import Literal

Language = Literal["en", "hi", "hi-en-mixed"]

# Devanagari block. Covers Hindi, and also Marathi/Nepali — out of scope, and a
# message in those would be reported as `hi`. Accepted: the alternative is
# script-plus-vocabulary disambiguation for languages Phase 3 does not support.
_DEVANAGARI = re.compile(r"[ऀ-ॿ]")
_LETTER = re.compile(r"[^\W\d_]", re.UNICODE)
_WORD_RE = re.compile(r"[a-z]+", re.ASCII)

# Enough Devanagari to be Hindi rather than a stray character pasted into English.
_DEVANAGARI_RATIO = 0.20

# Two distinct markers, not one: single common tokens (`ka`, `se`, `ho`) turn up in
# names and abbreviations often enough that one hit is not evidence.
_MARKER_THRESHOLD = 2

_ROMANIZED_HINDI_MARKERS: frozenset[str] = frozenset(
    {
        # copulas and negation — the highest-signal tokens in the language
        "hai", "hain", "h", "tha", "thi", "thee", "ho", "hu", "hun", "hoga", "hogi",
        "hona", "hone", "nhi", "nahi", "nahin", "naa",
        # pronouns and possessives
        "tum", "tu", "tune", "tumne", "tumhe", "tumhara", "tumhari", "tumse",
        "tujhe", "tujhse", "tera", "teri", "tere", "mai", "maine", "mujhe", "mujhse",
        "mera", "meri", "mere", "hum", "humein", "hamare", "apna", "apne", "apni",
        "khud", "wo", "woh", "yeh", "iska", "uska", "unka", "sabko",
        # interrogatives
        "kya", "kyu", "kyun", "kaise", "kaha", "kahan", "kaun", "kab",
        # verb stems and inflections, incl. the compressed spellings people type
        "kar", "kr", "karo", "karna", "krna", "kiya", "karke", "karta", "karti",
        "krta", "raha", "rha", "rahi", "rhi", "rahe", "rhe", "gaya", "gya", "gayi",
        "gyi", "gaye", "jayega", "jaunga", "jaungi", "jana", "aana", "aaya", "aayi",
        "dena", "lena", "sakte", "sakta", "sakti", "chahiye", "suna", "sunata",
        "bola", "dekh", "dekho", "dekha", "socha", "sochte", "poocha", "pucha",
        "liya", "laga", "lagi", "lgi", "padi", "sambhal", "hatani", "chhod", "rehne",
        "maangna", "milega", "bata", "bataya", "banane",
        # postpositions and connectives (English-colliding ones deliberately absent)
        "ka", "ki", "ke", "ko", "se", "mein", "pe", "tak", "bhi", "toh", "aur",
        "lekin", "magar", "agar", "phir", "isliye", "matlab", "wala", "wali",
        # quantifiers, intensifiers, time
        "kuch", "sab", "koi", "thoda", "zyada", "bhut", "bahut", "bilkul", "sirf",
        "baje", "baar", "teesri", "teen", "ek", "aaj", "kal", "abhi", "jaldi",
        "poori", "seedha", "bas", "mat", "mt", "ab",
        # frequent nouns and social vocabulary
        "yaar", "baat", "kaam", "ghar", "khana", "paisa", "waqt", "samay", "naam",
        "acha", "accha", "achha", "sahi", "thik", "theek", "yaad", "khush", "pyaar",
        "pyar", "shukriya", "dhanyavaad", "maaf", "galti", "safai", "gaadi",
    }
)


def _devanagari_ratio(text: str) -> float:
    letters = _LETTER.findall(text)
    if not letters:
        return 0.0
    return sum(1 for c in letters if _DEVANAGARI.match(c)) / len(letters)


def romanized_hindi_markers(text: str) -> list[str]:
    """Distinct romanized-Hindi markers present. Exposed so Step 3's evidence run can
    show *why* a message was classified, not just what it was classified as."""
    words = _WORD_RE.findall(text.lower())
    return sorted({w for w in words if w in _ROMANIZED_HINDI_MARKERS})


def _langdetect(text: str) -> str | None:
    """First-pass guess from langdetect, or None if it cannot decide. Never raises:
    it throws on input with no usable features, which is a normal chat message."""
    try:
        from langdetect import DetectorFactory, detect

        # langdetect randomizes its initial state; without a fixed seed the same
        # message can classify differently between runs, which would make the Step 3
        # accuracy number unreproducible.
        DetectorFactory.seed = 0
        return detect(text)
    except Exception:  # noqa: BLE001 - an undetectable string is not an error here
        return None


def detect_language(text: str) -> Language:
    """Classify one message as en / hi / hi-en-mixed. Never raises."""
    if not text or not text.strip():
        return "en"

    # Pass 1: script. Decisive — Devanagari is Hindi.
    if _devanagari_ratio(text) >= _DEVANAGARI_RATIO:
        return "hi"

    # Pass 2: romanized Hindi. Must run before trusting langdetect, which reports
    # `en` for almost all Hinglish.
    markers = romanized_hindi_markers(text)
    if len(markers) >= _MARKER_THRESHOLD:
        return "hi-en-mixed"

    # Pass 3: general-purpose detector for what is left.
    guess = _langdetect(text)
    if guess == "hi":
        # Latin script but langdetect says Hindi — only reachable via transliteration
        # profiles, so treat it as mixed rather than Devanagari.
        return "hi-en-mixed"

    # A single marker plus a non-English guess is weak evidence, but better than
    # calling it English.
    if markers and guess not in ("en", None):
        return "hi-en-mixed"

    return "en"
