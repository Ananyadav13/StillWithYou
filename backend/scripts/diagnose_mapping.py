"""Measurement-validity check: what actually decides each mood label?

Not a Step 4 run. This answers a narrower question asked before Step 4 was allowed to
proceed: given that the model emits 3 classes and the corpus is labelled with 4, how
much of the 4-way grading is testing the model and how much is testing the hand-written
lexicon and thresholds sitting on top of it?

For each fixture it reports the model's own output, whether the escalation lexicon
fired, and which branch of `_mood()` actually produced the answer.
"""

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8")

from app.services import multilingual_local as ml  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[1] / "tests/fixtures/multilingual_samples.json"


def lexicon_probe(text: str) -> tuple[float, list[str]]:
    """Re-run just the lexicon half of analyze_multilingual, so we can see it alone."""
    lowered = text.lower()
    words = set(ml._WORD_RE.findall(lowered))
    insult, hits = 0.0, []
    for table in (ml._INSULTS_EN, ml._INSULTS_HI, ml._INSULTS_HINGLISH):
        score, found = ml._lexicon_hit(lowered, words, table)
        insult = max(insult, score)
        hits.extend(found)
    if words & ml._PROFANITY:
        insult = max(insult, 0.75)
        hits.extend(sorted(words & ml._PROFANITY))
    return insult, hits


def decision_path(probs: dict, toxicity: float, heat: float, insult: float) -> str:
    """Name the branch of _mood() that fired."""
    top = max(probs, key=probs.get)
    if top == "negative":
        if insult >= 0.7:
            return "LEXICON  (insult>=0.7 -> angry)"
        if probs["negative"] >= 0.80:
            return "THRESHOLD(p_neg>=0.80 -> angry)"
        if toxicity >= 0.6 and heat >= 0.6:
            return "THRESHOLD(tox&heat -> angry)"
        return "MODEL    (negative -> frustrated)"
    if insult >= 0.8:
        return "LEXICON  (insult>=0.8 overrides -> angry)"
    if heat >= 0.55:
        return "THRESHOLD(heat>=0.55 -> frustrated)"
    return f"MODEL    ({top} -> {'calm' if top == 'positive' else 'neutral'})"


def main() -> None:
    samples = json.loads(FIXTURES.read_text(encoding="utf-8"))["samples"]
    ml.warm()

    paths = Counter()
    contaminated = []

    print(f"{'id':<12} {'expected':<11} {'got':<11} {'p_neg':>6} {'insult':>7}  decided by")
    print("-" * 100)

    for s in samples:
        text = s["text"]
        probs = ml._sentiment(text)
        result = ml.analyze_multilingual(text)
        insult, hits = lexicon_probe(text)
        path = decision_path(probs, result.toxicity_score, result.heat_score, insult)
        kind = path.split("(")[0].strip()
        paths[kind] += 1

        if hits:
            contaminated.append((s["id"], hits))

        print(
            f"{s['id']:<12} {s['expected_mood']:<11} {result.mood:<11} "
            f"{probs['negative']:>6.2f} {insult:>7.2f}  {path}"
        )

    print("\n--- what decided the label, across all 30 ---")
    for kind, count in paths.most_common():
        print(f"  {kind:<10} {count:>2}/30")

    print("\n--- fixtures containing a term from my own lexicon (circularity) ---")
    if not contaminated:
        print("  none")
    for fixture_id, hits in contaminated:
        print(f"  {fixture_id:<12} {sorted(set(hits))}")

    print("\n--- collapsed 3-class check: does the MODEL get polarity right? ---")
    gold_negative = {"frustrated", "angry"}
    correct = 0
    for s in samples:
        probs = ml._sentiment(s["text"])
        top = max(probs, key=probs.get)
        expected_neg = s["expected_mood"] in gold_negative
        got_neg = top == "negative"
        if expected_neg == got_neg:
            correct += 1
    print(f"  polarity (negative vs not) correct: {correct}/30")


if __name__ == "__main__":
    main()
