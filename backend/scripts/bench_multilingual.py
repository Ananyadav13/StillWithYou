"""Step 1 evidence: model size, cold-load time, and inference latency — measured, not assumed.

Run from `backend/`:  .venv/Scripts/python.exe scripts/bench_multilingual.py

Cold-load is measured in this process, so run it fresh. It is load-from-disk time and
excludes the one-time download; the download figure is reported separately as disk size.
"""

import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# The Windows console defaults to cp1252, which cannot encode Devanagari at all —
# printing a Hindi string raises UnicodeEncodeError before any result is shown.
sys.stdout.reconfigure(encoding="utf-8")

from app.services import multilingual_local as ml  # noqa: E402

EN = "You never listen to me. I'm honestly done trying to explain this."
HI = "तुम हमेशा मेरी बात अनसुनी कर देते हो। मैं थक गई हूँ अब समझाते समझाते।"
HINGLISH = "tum hamesha meri baat ignore kar dete ho, seriously main thak gayi hu ab"
CALM_EN = "Thanks for picking up the groceries today, that really helped."


def disk_size() -> tuple[float, str]:
    """Total bytes of the cached snapshot for this model."""
    from huggingface_hub import scan_cache_dir

    for repo in scan_cache_dir().repos:
        if repo.repo_id == ml.MODEL_ID:
            return repo.size_on_disk / 1e6, str(repo.repo_path)
    return 0.0, "<not cached>"


def main() -> None:
    print(f"model:      {ml.MODEL_ID}")

    t0 = time.perf_counter()
    ml.warm()
    cold_load = time.perf_counter() - t0
    print(f"cold load:  {cold_load:.2f}s (from disk, fresh process)")

    size_mb, path = disk_size()
    print(f"disk size:  {size_mb:.1f} MB")
    print(f"cache path: {path}")

    import torch

    print(f"torch:      {torch.__version__}, threads={torch.get_num_threads()}")

    print("\n--- sample analyses ---")
    for label, text in (("EN", EN), ("HI", HI), ("HINGLISH", HINGLISH), ("EN-calm", CALM_EN)):
        t = time.perf_counter()
        result = ml.analyze_multilingual(text)
        elapsed = (time.perf_counter() - t) * 1000
        print(f"\n[{label}] {text}")
        print(
            f"  -> mood={result.mood}  toxicity={result.toxicity_score}  "
            f"heat={result.heat_score}  source={result.source}  ({elapsed:.1f} ms)"
        )
        print(f"  -> rewrite: {result.rewrite_suggestion}")

    print("\n--- latency, 20 calls (alternating en/hi/hinglish) ---")
    corpus = [EN, HI, HINGLISH, CALM_EN]
    timings = []
    for i in range(20):
        t = time.perf_counter()
        ml.analyze_multilingual(corpus[i % len(corpus)])
        timings.append((time.perf_counter() - t) * 1000)

    timings_sorted = sorted(timings)
    print(f"  n=20  min={min(timings):.1f}ms  median={statistics.median(timings):.1f}ms  "
          f"p95={timings_sorted[18]:.1f}ms  max={max(timings):.1f}ms")


if __name__ == "__main__":
    main()
