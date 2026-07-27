"""Step 10: the whole fixture corpus through the real pipeline, with per-category floors.

NOTE: These floors assume backend/tests/fixtures/multilingual_samples.json
is unchanged. If this test fails immediately after editing that file
(adding/removing/relabeling fixtures), that is likely a fixture change,
not a model/code regression - re-baseline the floors against the new
fixture set rather than treating the failure as a regression. This
test cannot distinguish the two causes.

---

Why per-category floors rather than one aggregate number.

The previous version asserted a single total (32/45) with zero margin. That could not
tell "the analyzer got strictly worse" apart from "one category traded against
another", and it failed on any movement at all — including movement that left every
capability intact. Worse, it said nothing about *which* capability broke, which is the
only thing the failure needed to communicate.

Each floor is measured−1, so a single fixture flipping is tolerated as noise while a
genuine regression is caught. `angry` is the exception: it sits at a hard floor with no
slack, because at 6/15 there is nothing left to give away.

The overall floor is 30/45, chosen deliberately between two useless values:

  - at 32 (the measured total) the aggregate binds before any category floor can fire,
    which reinstates the zero-margin problem this design exists to remove;
  - at 29 (the exact sum of the four floors) it is arithmetically incapable of failing
    unless a category floor has already failed, so it is pure redundancy.

At 30 it does a job nothing else here can: catching **broad shallow degradation**, where
several categories each slip just inside their own floor and no single assertion
notices. One category regressing leaves 31 (passes); two leaves 30 (passes); three
leaves 29 (fails).

Requires Redis and Postgres (`docker compose up -d`) because it exercises the real
cache, not a mock.
"""

import json
from pathlib import Path

import pytest
import pytest_asyncio

from app.core.metrics import incr
from app.services import cache as cache_module
from app.services.cache import cache_key, get_cached, set_cached
from app.services.language_detect import detect_language
from app.services.multilingual_local import analyze_multilingual, warm

pytestmark = pytest.mark.asyncio(loop_scope="session")

FIXTURES = Path(__file__).parent / "fixtures/multilingual_samples.json"

# Per-category mood floors, baselined against the measured Step 4 run recorded in
# docs/phase3-results.md. Each is measured−1 except `angry`.
CALM_FLOOR = 7  # measured 8/9   - floor set at measured-1 to catch regression while tolerating normal fixture-level noise
NEUTRAL_FLOOR = 8  # measured 9/9   - floor set at measured-1 to catch regression while tolerating normal fixture-level noise
FRUSTRATED_FLOOR = 8  # measured 9/12  - floor set at measured-1 to catch regression while tolerating normal fixture-level noise
ANGRY_FLOOR = 6  # measured 6/15  - floor set at measured exactly; the known-weak category has no room to give
OVERALL_FLOOR = 30  # measured 32/45 - secondary backstop for multi-category slip, see module docstring

# Language detection keeps its original bar: 87%, restated from Step 10's 26/30.
LANGUAGE_BAR = 39


def load_samples() -> list[dict]:
    return json.loads(FIXTURES.read_text(encoding="utf-8"))["samples"]


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def pipeline_results() -> list[dict]:
    """Run every fixture through the full pipeline once, and reuse the outcome.

    Session-scoped because loading the model costs ~8s and running 45 inferences
    another ~2s; doing that per assertion would make the suite unpleasant enough
    that it stops being run.
    """
    await cache_module.clear()
    warm()

    results = []
    for sample in load_samples():
        text = sample["text"]

        language = detect_language(text)
        result = analyze_multilingual(text)

        # Exercise the cache for real: miss, write, then hit.
        before = await get_cached(text)
        await set_cached(text, result)
        after = await get_cached(text)

        await incr("analysis_local", language=language, mood=result.mood)

        results.append(
            {
                "id": sample["id"],
                "expected_language": sample["language"],
                "detected_language": language,
                "expected_mood": sample["expected_mood"],
                "got_mood": result.mood,
                "cache_missed_first": before is None,
                "cache_hit_after": after is not None,
                "cache_key": cache_key(text),
                "source": result.source,
            }
        )
    return results


def score(results: list[dict], mood: str) -> tuple[int, int, list[str]]:
    """Correct, total, and a readable list of misses for one expected mood."""
    subset = [r for r in results if r["expected_mood"] == mood]
    correct = sum(r["got_mood"] == r["expected_mood"] for r in subset)
    misses = [f"{r['id']} -> {r['got_mood']}" for r in subset if r["got_mood"] != r["expected_mood"]]
    return correct, len(subset), misses


# Each category gets its own test rather than sharing one function with five asserts.
# With a single function the first failing assert masks the rest, so a run that broke
# both `calm` and `angry` would report only `calm` — and this test exists precisely to
# say *which* capability regressed.


async def test_calm_accuracy_meets_floor(pipeline_results) -> None:
    calm_correct, total, misses = score(pipeline_results, "calm")
    assert calm_correct >= CALM_FLOOR, (
        f"calm accuracy {calm_correct}/{total} fell below floor {CALM_FLOOR}/9 - "
        f"regression in calm-tone detection. Misses: {misses}"
    )


async def test_neutral_accuracy_meets_floor(pipeline_results) -> None:
    neutral_correct, total, misses = score(pipeline_results, "neutral")
    assert neutral_correct >= NEUTRAL_FLOOR, (
        f"neutral accuracy {neutral_correct}/{total} fell below floor {NEUTRAL_FLOOR}/9 - "
        f"regression in neutral-tone detection. Misses: {misses}"
    )


async def test_frustrated_accuracy_meets_floor(pipeline_results) -> None:
    frustrated_correct, total, misses = score(pipeline_results, "frustrated")
    assert frustrated_correct >= FRUSTRATED_FLOOR, (
        f"frustrated accuracy {frustrated_correct}/{total} fell below floor "
        f"{FRUSTRATED_FLOOR}/12 - regression in frustrated-tone detection. Misses: {misses}"
    )


async def test_angry_accuracy_meets_floor(pipeline_results) -> None:
    angry_correct, total, misses = score(pipeline_results, "angry")
    assert angry_correct >= ANGRY_FLOOR, (
        f"angry accuracy {angry_correct}/{total} fell below floor {ANGRY_FLOOR}/15 - "
        f"regression in low-affect anger detection (this category has zero margin "
        f"by design). Misses: {misses}"
    )


async def test_overall_accuracy_meets_floor(pipeline_results) -> None:
    """Backstop for degradation too shallow for any single category floor to catch."""
    total_correct = sum(r["got_mood"] == r["expected_mood"] for r in pipeline_results)
    per_category = {
        mood: f"{score(pipeline_results, mood)[0]}/{score(pipeline_results, mood)[1]}"
        for mood in ("calm", "neutral", "frustrated", "angry")
    }
    assert total_correct >= OVERALL_FLOOR, (
        f"overall accuracy {total_correct}/{len(pipeline_results)} fell below floor "
        f"{OVERALL_FLOOR}/45 - broad degradation across multiple categories (each "
        f"passed its own floor individually, but the aggregate caught a shallow "
        f"multi-category slip). Per category: {per_category}"
    )


async def test_language_detection_meets_bar(pipeline_results) -> None:
    correct = sum(r["detected_language"] == r["expected_language"] for r in pipeline_results)
    misses = [
        f"{r['id']}: expected {r['expected_language']}, got {r['detected_language']}"
        for r in pipeline_results
        if r["detected_language"] != r["expected_language"]
    ]
    assert correct >= LANGUAGE_BAR, (
        f"language detection {correct}/{len(pipeline_results)}, "
        f"bar is {LANGUAGE_BAR}. Misses: {misses}"
    )


async def test_every_fixture_produced_a_result(pipeline_results) -> None:
    """No fixture may silently fail to be analysed — the Phase 2 guarantee."""
    assert len(pipeline_results) == 45
    assert all(r["source"] == "multilingual_local" for r in pipeline_results)
    assert all(r["got_mood"] in ("calm", "neutral", "frustrated", "angry") for r in pipeline_results)


async def test_cache_round_trips_every_script(pipeline_results) -> None:
    """Every fixture missed the cache, then hit it — including Devanagari."""
    assert all(r["cache_missed_first"] for r in pipeline_results)
    assert all(r["cache_hit_after"] for r in pipeline_results)


async def test_no_cache_key_collisions(pipeline_results) -> None:
    """45 distinct messages must produce 45 distinct keys, across all three scripts."""
    keys = [r["cache_key"] for r in pipeline_results]
    assert len(set(keys)) == len(keys), "two different fixtures share a cache key"


async def test_per_category_scores_are_reported(pipeline_results, capsys) -> None:
    """Not a bar — prints the breakdown so any failure above is readable in context."""
    floors = {
        "calm": CALM_FLOOR,
        "neutral": NEUTRAL_FLOOR,
        "frustrated": FRUSTRATED_FLOOR,
        "angry": ANGRY_FLOOR,
    }
    with capsys.disabled():
        print()
        for mood, floor in floors.items():
            correct, total, _ = score(pipeline_results, mood)
            margin = correct - floor
            print(f"    {mood:<11} {correct:>2}/{total:<3} floor {floor}/{total}  margin {margin:+d}")
        total_correct = sum(r["got_mood"] == r["expected_mood"] for r in pipeline_results)
        print(f"    {'OVERALL':<11} {total_correct:>2}/45  floor {OVERALL_FLOOR}/45  "
              f"margin {total_correct - OVERALL_FLOOR:+d}")
        for language in ("en", "hi", "hi-en-mixed"):
            subset = [r for r in pipeline_results if r["expected_language"] == language]
            correct = sum(r["got_mood"] == r["expected_mood"] for r in subset)
            print(f"    {language:<11} mood {correct}/{len(subset)}")
