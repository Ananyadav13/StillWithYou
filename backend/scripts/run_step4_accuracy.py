"""Step 4 evidence: run all 45 fixtures through analyze_multilingual() and grade them.

Reports three numbers per language, because one number would be misleading:

  polarity      does the MODEL get negative vs not-negative right? This is the only
                thing a 3-class sentiment model actually claims to do, and it is
                independent of the hand-written mapping on top.
  4-way         exact match on calm/frustrated/angry/neutral, lexicon enabled. This is
                what the product actually returns.
  4-way no-lex  the same, with the escalation lexicon switched off. The lexicon and the
                corpus share an author, so the gap between this and the previous
                column is the size of that conflict of interest.

Exact match only. No partial credit for "close".
"""

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8")

from app.services import multilingual_local as ml  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[1] / "tests/fixtures/multilingual_samples.json"
NEGATIVE_MOODS = {"frustrated", "angry"}
LANGS = ("en", "hi", "hi-en-mixed")


def main() -> None:
    samples = json.loads(FIXTURES.read_text(encoding="utf-8"))["samples"]
    ml.warm()

    rows = []
    for s in samples:
        text = s["text"]
        probs = ml._sentiment(text)
        full = ml.analyze_multilingual(text)
        nolex = ml.analyze_multilingual(text, use_lexicon=False)

        expected = s["expected_mood"]
        rows.append(
            {
                "id": s["id"],
                "lang": s["language"],
                "text": text,
                "expected": expected,
                "got": full.mood,
                "got_nolex": nolex.mood,
                "tox": full.toxicity_score,
                "heat": full.heat_score,
                "p_neg": probs["negative"],
                "correct": full.mood == expected,
                "correct_nolex": nolex.mood == expected,
                "polarity_ok": (max(probs, key=probs.get) == "negative")
                == (expected in NEGATIVE_MOODS),
            }
        )

    print("| id | expected | model mood | toxicity | heat | correct? |")
    print("|---|---|---|---|---|---|")
    for r in rows:
        print(
            f"| {r['id']} | {r['expected']} | {r['got']} | {r['tox']:.2f} | "
            f"{r['heat']:.2f} | {'YES' if r['correct'] else 'NO'} |"
        )

    print("\n=== accuracy by category (exact match only) ===\n")
    print(f"{'language':<14} {'4-way':<10} {'4-way no-lex':<14} {'polarity (model only)':<22}")
    print("-" * 62)
    for lang in LANGS:
        sub = [r for r in rows if r["lang"] == lang]
        n = len(sub)
        print(
            f"{lang:<14} {sum(r['correct'] for r in sub)}/{n:<8} "
            f"{sum(r['correct_nolex'] for r in sub)}/{n:<12} "
            f"{sum(r['polarity_ok'] for r in sub)}/{n}"
        )
    total = len(rows)
    print("-" * 62)
    print(
        f"{'TOTAL':<14} {sum(r['correct'] for r in rows)}/{total:<8} "
        f"{sum(r['correct_nolex'] for r in rows)}/{total:<12} "
        f"{sum(r['polarity_ok'] for r in rows)}/{total}"
    )

    print("\n=== accuracy by mood label ===")
    for mood in ("calm", "neutral", "frustrated", "angry"):
        sub = [r for r in rows if r["expected"] == mood]
        print(f"  {mood:<11} {sum(r['correct'] for r in sub)}/{len(sub)}")

    print("\n=== confusion: expected -> got ===")
    confusion = Counter((r["expected"], r["got"]) for r in rows if not r["correct"])
    for (exp, got), count in confusion.most_common():
        print(f"  {exp:<11} -> {got:<11} {count}")

    print("\n=== every miss, in full ===")
    for r in rows:
        if r["correct"]:
            continue
        print(f"\n  {r['id']} ({r['lang']}): expected {r['expected']}, got {r['got']}")
        print(f"    {r['text']}")
        print(f"    p_neg={r['p_neg']:.2f}  toxicity={r['tox']:.2f}  heat={r['heat']:.2f}")

    print("\n=== lexicon-disabled deltas (where turning the lexicon off changes the answer) ===")
    changed = [r for r in rows if r["got"] != r["got_nolex"]]
    if not changed:
        print("  none")
    for r in changed:
        print(
            f"  {r['id']:<13} expected {r['expected']:<11} "
            f"with-lex {r['got']:<11} without-lex {r['got_nolex']:<11} p_neg={r['p_neg']:.2f}"
        )


if __name__ == "__main__":
    main()
