"""Step 5, bounded experiment: does an independent toxicity model see cold anger?

The pass criterion was fixed in docs/phase3-results.md before this was run:

    Keep the second model only if it turns at least 5 of the 9 missed `angry`
    fixtures into `angry`, without breaking the 6 that already pass and without
    dropping total accuracy below 32/45.

Judged against the failure set, not overall accuracy. This swap is only justified if
it fixes the specific thing it was introduced to fix.

Deliberately probe-first: this reads the toxicity model's raw scores on the 15 `angry`
fixtures before any integration code is written. If the scores on the 9 misses are
uniformly low, the hypothesis (that a toxicity classifier is a proxy for loud
negativity and is blind to quiet withdrawal, exactly as the sentiment model is) is
confirmed, and there is no reason to build the integration at all.
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8")

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

TOXICITY_MODEL = "textdetox/xlmr-large-toxicity-classifier"
FIXTURES = Path(__file__).resolve().parents[1] / "tests/fixtures/multilingual_samples.json"

# The 9 fixtures labelled `angry` that the baseline scores otherwise. Fixed in advance.
FAILURE_SET = {
    "en-13", "en-15", "hi-09", "hi-13", "hi-14", "hi-15",
    "hinglish-13", "hinglish-14", "hinglish-15",
}


def main() -> None:
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(TOXICITY_MODEL)
    model = AutoModelForSequenceClassification.from_pretrained(TOXICITY_MODEL)
    model.eval()
    id2label = {int(k): str(v).lower() for k, v in (model.config.id2label or {}).items()}
    print(f"model:  {TOXICITY_MODEL}")
    print(f"labels: {id2label}\n")

    samples = json.loads(FIXTURES.read_text(encoding="utf-8"))["samples"]
    angry = [s for s in samples if s["expected_mood"] == "angry"]

    def toxicity(text: str) -> float:
        enc = tokenizer(text, return_tensors="pt", truncation=True, max_length=128)
        with torch.no_grad():
            probs = torch.softmax(model(**enc).logits[0], dim=-1).tolist()
        scored = {id2label.get(i, str(i)): p for i, p in enumerate(probs)}
        # Label naming varies between revisions; take whichever key means "toxic".
        for key in ("toxic", "toxicity", "label_1", "1"):
            if key in scored:
                return scored[key]
        return max(scored.values())

    print(f"{'fixture':<13} {'in failure set':<15} {'p_toxic':>8}   text")
    print("-" * 100)

    missed_scores, passing_scores = [], []
    for s in sorted(angry, key=lambda x: x["id"]):
        score = toxicity(s["text"])
        in_fs = s["id"] in FAILURE_SET
        (missed_scores if in_fs else passing_scores).append((s["id"], score))
        print(
            f"{s['id']:<13} {'MISSED' if in_fs else 'already ok':<15} {score:>8.3f}   "
            f"{s['text'][:60]}"
        )

    print("\n--- the 9 the swap is meant to fix ---")
    for fixture_id, score in missed_scores:
        print(f"  {fixture_id:<13} p_toxic={score:.3f}")

    print("\n--- the 6 that already pass (mostly contain lexicon insults) ---")
    for fixture_id, score in passing_scores:
        print(f"  {fixture_id:<13} p_toxic={score:.3f}")

    # Best case for the intervention: even choosing the most generous possible
    # threshold, how many of the 9 could ever be recovered without also firing on
    # calm/neutral fixtures?
    non_angry = [s for s in samples if s["expected_mood"] in ("calm", "neutral")]
    ceiling = max(toxicity(s["text"]) for s in non_angry)
    recoverable = [f for f, sc in missed_scores if sc > ceiling]

    print(f"\nhighest p_toxic across all calm/neutral fixtures: {ceiling:.3f}")
    print("  (any threshold at or below this starts mislabelling calm/neutral messages)")
    print(f"\nmissed fixtures scoring above that ceiling: {len(recoverable)}/9  {recoverable}")
    print(f"\nPASS CRITERION: >= 5 of 9.  RESULT: {len(recoverable)}/9 -> "
          f"{'KEEP' if len(recoverable) >= 5 else 'REVERT'}")


if __name__ == "__main__":
    main()
