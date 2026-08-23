#!/usr/bin/env python3
"""Generate a consolidated benchmark summary report across tested models.

Reads only bench/results/*/metrics.json (written by score/score.py). No fallback
numbers - if there's nothing to read, this exits with an error instead of printing
data that was never measured.
"""

import json
import sys
from pathlib import Path


def num(x, digits=4):
    return "—" if x is None else f"{x:.{digits}f}"


def pct(x):
    return "—" if x is None else f"{x * 100:.1f}%"


RULE_LABELS = {
    "hanjaLeak": "noHanjaLeak", "fenced": "noFence", "prosePreamble": "noPreamble",
    "salvaged": "notSalvaged", "retried": "notRetried", "empty": "nonEmpty",
}

def main():
    bench_root = Path(__file__).resolve().parent
    results_dir = bench_root / "results"

    runs = []
    if results_dir.exists():
        for run_path in sorted(results_dir.glob("*")):
            metrics_file = run_path / "metrics.json"
            if not metrics_file.exists():
                continue
            try:
                runs.append(json.loads(metrics_file.read_text(encoding="utf-8")))
            except Exception as e:
                print(f"  skipping {metrics_file}: {e}", file=sys.stderr)

    if not runs:
        sys.exit("No metrics.json found under bench/results/. Run src/run.js then score/score.py first.")

    lines = []
    lines.append("# Haen Benchmark Report — Consolidated Results\n")
    lines.append("> Measured from `bench/results/*/metrics.json`. Every number below traces back to a")
    lines.append("> real run - see the `git sha` / `prompt hash` columns to reproduce it.\n")

    names = ", ".join(sorted({r["config"].get("name", r["config"].get("modelId", "?")) for r in runs}))
    lines.append(f"Benchmarked **{len(runs)} model(s)**: {names}.\n")

    lines.append("## Model Benchmark Comparison Matrix\n")
    lines.append("| Model | Provider | n (items × runs) | Compliance (worst rule) | COMET (95% CI) | chrF++ | Latency (p50/p90/p99) | Streaming TTFB (p50) | Cost / 1k | Prices as of |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")

    lower_bound_rows = []
    for r in runs:
        c = r.get("config", {})
        op = r.get("operational", {})
        comp = r.get("compliance", {})
        var = r.get("runVariance", {})
        quality = r.get("quality", {})

        name = c.get("name", c.get("modelId", "Unknown"))
        provider = c.get("provider", "Unknown")
        n = f"{r.get('itemCount', '—')} × {var.get('runs', '—')}"

        # The weakest rule, not hasAllRequired. This column used to read hasAllRequired
        # alone, which is one of the fifteen checks and the easiest to pass - gpt-oss-20b
        # scored 100% on it while emitting invalid JSON on 2.4% of items and the wrong
        # number of alternatives on 3.8%. A single "Compliance" number has to be the floor
        # across the suite or it advertises a pass the run did not earn. Per-rule detail
        # stays in each run's own report.md.
        rules = comp.get("overall", {})
        worst = min(rules.items(), key=lambda kv: kv[1]) if rules else None
        comp_rate = f"{pct(worst[1])} ({RULE_LABELS.get(worst[0], worst[0])})" if worst else "—"

        comet = (quality.get("comet") or {}).get("overall")
        comet_str = f"{num(comet['system'])} ({comet['ci'][0]:.3f}–{comet['ci'][1]:.3f})" if comet and comet.get("ci") else (num(comet["system"]) if comet else "—")

        ngram = (quality.get("ngram") or {}).get("overall")
        chrf_str = num(ngram["chrf2"], 2) if ngram else "—"

        lat = op.get("latencyMs", {})
        lat_str = f"{lat.get('p50', '—')} / {lat.get('p90', '—')} / {lat.get('p99', '—')} ms"

        ttfb = op.get("ttfbMs")
        ttfb_str = f"{ttfb['p50']} ms" if ttfb else "—"

        cost = op.get("costPer1kTranslations")
        cost_str = f"${cost:.4f}" if cost is not None else "—"
        # A run that never measured thinking tokens billed them at zero, so its cost is
        # a floor, not a figure. Unmarked, this column silently mixes two definitions of
        # "cost" and a reader ranking models by it gets a wrong answer that looks valid.
        if op.get("costIsLowerBound"):
            cost_str += " ≥"
            lower_bound_rows.append(name)

        prices_at = op.get("pricesFetchedAt") or "—"

        lines.append(
            f"| **{name}** | `{provider}` | {n} | {comp_rate} | {comet_str} | {chrf_str} | "
            f"{lat_str} | {ttfb_str} | {cost_str} | {prices_at} |"
        )

    lines.append("")
    if lower_bound_rows:
        lines.append(
            f"> **`≥` marks a cost that excludes thinking tokens** ({', '.join(sorted(lower_bound_rows))}). "
            "Those runs predate `reasoning_tokens`, or the provider returned no `total_tokens` to derive it "
            "from, so hidden thinking was billed at zero. On `gemini-3.7-flash` that same omission "
            "understated the cost by roughly half - do not rank models on a column that mixes marked and "
            "unmarked rows without re-running the marked ones. An unmarked row is not automatically "
            "exact either: a run recorded before `null` replaced the clamped `0` can hold items that were "
            "never measured and cannot now say so, which makes `gemini-3.7-flash`'s own $3.0176 a ~4% "
            "floor as well (docs/MEASUREMENT-NOTES.md 5).\n"
        )
    # reasoningEffort is a field in the request body, not a property of the response.
    # A backend that ignores it answers normally and the run is still named "-nothink",
    # so every artifact would report what was asked for and never what happened. The one
    # metric that could contradict it does not: providers that fold thinking into
    # completion_tokens report reasoning_tokens 0 whether the lever worked or was dropped.
    effort_rows = sorted(
        f"{(r.get('config') or {}).get('name', '?')} (`{(r.get('config') or {}).get('reasoningEffort')}`)"
        for r in runs if (r.get("config") or {}).get("reasoningEffort")
    )
    if effort_rows:
        lines.append(
            f"> **Thinking budget was requested, not verified**, on: {', '.join(effort_rows)}. "
            "`reasoning_effort` is sent in the request body and a backend that ignores it returns a "
            "normal response, so treat the latency drop as the evidence the lever landed - not the "
            "run name.\n"
        )
    lines.append("## Determinism & Reproducibility\n")
    lines.append("| Model | identical output rate | chrF++ stdev (tie threshold) | failure rate | retry rate | git sha | prompt hash |")
    lines.append("|---|---|---|---|---|---|---|")
    for r in runs:
        c = r.get("config", {})
        op = r.get("operational", {})
        var = r.get("runVariance", {})
        name = c.get("name", c.get("modelId", "Unknown"))
        identical = pct(var.get("identicalOutputRate"))
        stdev = var.get("chrf2_stdev")
        tie = f"{num(stdev, 3)} (±{num(stdev * 2, 3)})" if stdev is not None else "—"
        git = c.get("git") or {}
        sha = (git.get("sha") or "?")[:12]
        # A dirty tree means the sha names a commit the run did not actually use. Marked
        # here, not only in each run's own report.md, because this is the table that puts
        # models side by side - and comparing two rows is exactly when "which code
        # measured this" stops being a footnote.
        sha_cell = f"`{sha}`" + (" **(dirty)**" if git.get("dirty") else "")
        phash = (c.get("promptHash") or "?")[:12]
        lines.append(f"| {name} | {identical} | {tie} | {pct(op.get('failureRate'))} | {pct(op.get('retryRate'))} | {sha_cell} | `{phash}…` |")

    shas = {((r.get("config") or {}).get("git") or {}).get("sha") for r in runs}
    dirty = sorted((r.get("config") or {}).get("name", "?") for r in runs
                   if ((r.get("config") or {}).get("git") or {}).get("dirty"))
    lines.append("")
    if len(shas) > 1 or dirty:
        # The rows above are only comparable if the same harness measured them. They often
        # were not: a parser fix or a routing change between two runs moves the compliance
        # and latency columns without the model changing at all.
        lines.append("> **These rows were not all measured by the same code.** "
                     f"{len(shas)} distinct git sha(s) across {len(runs)} run(s)"
                     + (f"; dirty working tree for {', '.join(dirty)}" if dirty else "")
                     + ". A dirty tree means the recorded sha is a lower bound, not the code that ran.")
        lines.append("> Before reading a cross-model delta off this table, check that no run predates")
        lines.append("> a change to the parsing, request, or scoring path - and re-run the ones that do.\n")
    lines.append("> **How to read this.** Absolute scores mean nothing; only deltas between models do.")
    lines.append("> If two models' COMET scores differ by less than 2× the chrF++ stdev (tie threshold")
    lines.append("> column above), treat them as tied - that's the noise floor from re-running the same")
    lines.append("> config, not a real quality gap.\n")

    # LLM-as-judge. The four structured fields have no reference translation, so nothing
    # else in this file can see them: COMET scores `natural` alone and compliance only asks
    # whether `nuance` exists, not whether it says anything. A model can hold 100% on every
    # rule here and still emit filler - which is what this table is for.
    judged = [r for r in runs if r.get("judge")]
    if judged:
        criteria = ["naturalFluent", "nuanceGrounded", "altsDistinct", "tipFactual"]
        judge_ids = {r["judge"].get("judgeModelId") for r in judged}
        lines.append("## Structured-output quality (LLM-as-judge)\n")
        lines.append("| Model | n | " + " | ".join(criteria) + " |")
        lines.append("|---|---|" + "---|" * len(criteria))
        for r in judged:
            j = r["judge"]
            name = r.get("config", {}).get("name", "Unknown")
            cells = " | ".join(pct(j["rates"].get(k)) for k in criteria)
            lines.append(f"| {name} | {j.get('n', '—')} | {cells} |")
        lines.append("")
        # Scores from different judges are different measurements wearing the same column
        # header, so say it out loud rather than letting the table imply one scale.
        if len(judge_ids) > 1:
            lines.append("> **These rows were not judged by the same model** (" +
                         ", ".join(f"`{i}`" for i in sorted(judge_ids)) +
                         "). The numbers are not comparable to each other until they are.\n")
        else:
            lines.append(f"> Judge: `{judge_ids.pop()}`, binary rubric, same subset for every model.")
            lines.append("> Judge scores carry the judge's own biases and are for relative comparison")
            lines.append("> between the models in this table only.\n")

    content = "\n".join(lines) + "\n"
    report_file = bench_root / "REPORT.md"
    report_file.write_text(content, encoding="utf-8")
    print(f"Consolidated report written to {report_file}")


if __name__ == "__main__":
    main()
