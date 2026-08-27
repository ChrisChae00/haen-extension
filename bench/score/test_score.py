"""Self-check for the cost arithmetic. Run: python3 bench/score/test_score.py

The cost per 1,000 translations is the one number the whole harness exists to produce,
and it is the one that fails silently: a wrong figure looks exactly like a right one.
These pin the thinking-token accounting, which has already been wrong once
(docs/ENGINEERING-LOG.md 1.9) and understated a model's cost by roughly half.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from score import SCORING_VERSION, operational  # noqa: E402

PRICING = {"m": {"inputPer1M": 1.0, "outputPer1M": 10.0, "fetchedAt": "2026-08-21"}}
CONFIG = {"modelId": "m", "provider": "google"}


def rec(prompt, completion, reasoning="omit"):
    usage = {"prompt_tokens": prompt, "completion_tokens": completion}
    if reasoning != "omit":
        usage["reasoning_tokens"] = reasoning
    return {"latencyMs": 100, "usage": usage}


def test_thinking_tokens_are_billed_at_the_output_rate():
    without = operational([rec(100, 50, 0)], CONFIG, PRICING)
    with_thinking = operational([rec(100, 50, 200)], CONFIG, PRICING)
    # 200 extra output tokens at $10/1M, over 1,000 translations = $2.00.
    assert with_thinking["costPer1kTranslations"] - without["costPer1kTranslations"] == 2.0
    assert with_thinking["tokens"]["reasoningTotal"] == 200
    assert without["costIsLowerBound"] is False


def test_a_run_predating_the_field_is_unmeasured_not_zero():
    op = operational([rec(100, 50), rec(100, 50)], CONFIG, PRICING)
    # None, not 0: nothing here can tell a model that does not think from one that was
    # never counted, and printing 0 would let this cost sit unmarked beside a corrected one.
    assert op["tokens"]["reasoningTotal"] is None
    assert op["tokens"]["reasoningMean"] is None
    assert op["costIsLowerBound"] is True


def test_a_missing_total_tokens_marks_the_cost_a_floor():
    # haen.js writes null when the provider sent no total_tokens to derive the gap from.
    op = operational([rec(100, 50, 200), rec(100, 50, None)], CONFIG, PRICING)
    assert op["tokens"]["reasoningTotal"] == 200      # what is known, not a guess at the rest
    assert op["tokens"]["reasoningUnmeasured"] == 1
    assert op["costIsLowerBound"] is True


def test_a_local_model_is_free_and_never_a_lower_bound():
    op = operational([rec(100, 50)], {"modelId": "m", "provider": "ollama"}, PRICING)
    assert op["costPer1kTranslations"] == 0.0
    assert op["costIsLowerBound"] is False


def test_the_scoring_version_matches_the_javascript_side():
    """A check added in compliance.js with the version bumped only there would let two
    runs scored by different code claim to be comparable."""
    js = (Path(__file__).resolve().parent.parent / "src/compliance.js").read_text(encoding="utf-8")
    match = re.search(r"export const SCORING_VERSION = (\d+);", js)
    assert match, "compliance.js no longer exports SCORING_VERSION"
    assert int(match.group(1)) == SCORING_VERSION, (
        f"compliance.js says {match.group(1)}, score.py says {SCORING_VERSION}"
    )


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all passed")
