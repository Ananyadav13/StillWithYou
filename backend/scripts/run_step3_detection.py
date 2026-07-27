"""Step 3 evidence: run detect_language() over every fixture and report accuracy.

Prints one row per fixture with the actual language beside the detected one, the
markers that drove the decision, and what langdetect alone would have said — so a
mismatch can be read rather than hand-waved.
"""

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8")

from app.services.language_detect import (  # noqa: E402
    _langdetect,
    detect_language,
    romanized_hindi_markers,
)

FIXTURES = Path(__file__).resolve().parents[1] / "tests/fixtures/multilingual_samples.json"


def main() -> None:
    samples = json.loads(FIXTURES.read_text(encoding="utf-8"))["samples"]

    correct = 0
    per_lang: Counter[str] = Counter()
    per_lang_total: Counter[str] = Counter()
    misses = []

    print(f"{'id':<13} {'actual':<12} {'detected':<12} {'ok':<4} {'langdetect':<11} markers")
    print("-" * 104)

    for s in samples:
        actual = s["language"]
        detected = detect_language(s["text"])
        ok = detected == actual
        correct += ok
        per_lang_total[actual] += 1
        per_lang[actual] += ok

        markers = romanized_hindi_markers(s["text"])
        raw = _langdetect(s["text"]) or "-"
        shown = ",".join(markers[:6]) + ("..." if len(markers) > 6 else "")

        print(
            f"{s['id']:<13} {actual:<12} {detected:<12} {'OK' if ok else 'MISS':<4} "
            f"{raw:<11} {shown}"
        )
        if not ok:
            misses.append((s["id"], actual, detected, s["text"], markers, raw))

    total = len(samples)
    print(f"\n=== detection accuracy: {correct}/{total} ===")
    for lang in ("en", "hi", "hi-en-mixed"):
        print(f"  {lang:<12} {per_lang[lang]}/{per_lang_total[lang]}")

    print("\n--- what langdetect alone would have scored ---")
    ld_correct = 0
    for s in samples:
        raw = _langdetect(s["text"])
        mapped = {"hi": "hi", "en": "en"}.get(raw or "", "en")
        ld_correct += mapped == s["language"]
    print(f"  langdetect only (hi->hi, everything else->en): {ld_correct}/{total}")

    if misses:
        print("\n--- mismatches, in full ---")
        for fixture_id, actual, detected, text, markers, raw in misses:
            print(f"\n  {fixture_id}: expected {actual}, got {detected}")
            print(f"    text:       {text}")
            print(f"    markers:    {markers}")
            print(f"    langdetect: {raw}")


if __name__ == "__main__":
    main()
