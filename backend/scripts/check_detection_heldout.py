"""Held-out check for detect_language(), on text the marker list was not written against.

Step 3 scores 45/45 on the fixture corpus, which is not by itself trustworthy: the
marker list was written after the fixtures and by the same author, so a perfect score
is partly a measure of how well it memorised them.

These messages are real — sent between Ananya and their friends, supplied verbatim, and
not consulted while building the marker list. They also cover the case the fixtures are
thin on: English that merely *looks* informal ("bro", "bae", "Ik"), where a false
`hi-en-mixed` would be the damaging error.

Expectations are recorded here as the obvious reading of each message.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8")

from app.services.language_detect import detect_language, romanized_hindi_markers  # noqa: E402

HELD_OUT = [
    (
        "oh abhi matlab mattress nhi layi h tU, nhi saaf hoga dhange se aur thaki hogi "
        "to aaj unme se kisi ek ke room me so jana",
        "hi-en-mixed",
    ),
    (
        "Ik you guys did your best, koi baat nhi next drive me ho Jayega",
        "hi-en-mixed",
    ),
    (
        "all the best to CRED wale sorry mai so rhi thi pehle wish nhi kar paayi",
        "hi-en-mixed",
    ),
    (
        "all the best bro for tomorrow, that role is just for you, you will nail "
        "tomorrow's round and all the next that comes, this opportunity is yours",
        "en",
    ),
    (
        "May you have the best year of your life ahead. I hope my words become an "
        "amulet that always protects your happiness and liveliness; your presence is "
        "a very soothing comfort. You brighten the room you enter.",
        "en",
    ),
    (
        "Not so perfect but so beautiful. Yes you are, that's why your life and your "
        "journey both would be so beautiful, so imperfectly perfect",
        "en",
    ),
]


def main() -> None:
    correct = 0
    for text, expected in HELD_OUT:
        got = detect_language(text)
        ok = got == expected
        correct += ok
        markers = romanized_hindi_markers(text)
        print(f"[{'OK' if ok else 'MISS'}] expected {expected:<12} got {got:<12}")
        print(f"       {text[:88]}{'...' if len(text) > 88 else ''}")
        print(f"       markers ({len(markers)}): {markers}\n")

    print(f"=== held-out detection: {correct}/{len(HELD_OUT)} ===")


if __name__ == "__main__":
    main()
