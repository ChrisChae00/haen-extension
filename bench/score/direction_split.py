#!/usr/bin/env python3
"""Split judge results by translation direction.

Run 2's idiom sources are all Korean, so they only ever add ko_to_en training records.
If the training taught idiom handling, the gain should be lopsided toward that direction.
If it shows up in both, whatever moved is not the idiom content -- and that distinction is
the whole reason to look.

No p-values here on purpose. The sign test has one implementation, in judge.js, and each
direction is only 20 items -- a p-value on that would invite reading noise as a result.
Counts and rates only.

    .venv/bin/python score/direction_split.py results/<control> results/<candidate> ...
"""
import json
import sys
from collections import Counter
from pathlib import Path

CRITERIA = ["naturalFluent", "nuanceGrounded", "altsDistinct", "tipFactual"]
DIRECTIONS = ["ko_to_en", "en_to_ko"]


def load_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


def main(run_dirs):
    bench = Path(__file__).resolve().parent.parent
    dataset = {r["id"]: r for r in load_jsonl(bench / "datasets/v1/handbuilt-ext.jsonl")}
    runs = [Path(d) for d in run_dirs]
    names = [json.loads((d / "config.json").read_text(encoding="utf-8"))["name"] for d in runs]

    for direction in DIRECTIONS:
        print(f"\n=== absolute judge — {direction} ===")
        print(f"{'criterion':16}" + "".join(f"{n[-18:]:>20}" for n in names))
        counts = []
        for d in runs:
            rows = [r for r in load_jsonl(d / "judge.jsonl") if dataset[r["id"]]["direction"] == direction] \
                if (d / "judge.jsonl").exists() else []
            counts.append(rows)
        for c in CRITERIA:
            cells = ""
            for rows in counts:
                if not rows:
                    cells += f"{'—':>20}"
                    continue
                hits = sum(1 for r in rows if r["scores"].get(c))
                cells += f"{f'{hits}/{len(rows)} ({hits / len(rows):.0%})':>20}"
            print(f"{c:16}{cells}")

    for d, name in zip(runs, names):
        path = d / "pairwise.jsonl"
        if not path.exists():
            continue
        print(f"\n=== pairwise vs baseline — {name} ===")
        rows = load_jsonl(path)
        for criterion in ("natural", "nuance"):
            for direction in DIRECTIONS:
                sub = [r for r in rows if dataset[r["id"]]["direction"] == direction]
                tally = Counter(r["winner"][criterion] for r in sub)
                print(f"  {criterion:8} {direction:9} n={len(sub):2}  "
                      f"candidate {tally['candidate']:2}  baseline {tally['baseline']:2}  ties {tally['tie']:2}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
