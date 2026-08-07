#!/usr/bin/env python3
"""Score a benchmark run and write metrics.json + report.md.

Scoring is deterministic: run this twice on the same predictions and you get identical
output. Every non-determinism in the pipeline lives on the generation side, which is
exactly why it is measured separately (see run_variance below).

Three things here are deliberate and worth not "fixing":

1. There are no per-slice quality scores. Fifty items per slice gives a bootstrap
   interval wider than any between-slice gap, so a per-slice chrF table would be a
   table of noise that reads like a result. Slices carry compliance rates only - those
   are proportions and stay meaningful at n=50 - plus `--slice` for eyeballing samples.

2. COMET is the headline, chrF++/BLEU are demoted to a reference table. Both n-gram
   metrics are a bad fit here: Korean colloquial speech has a wide space of correct
   answers that three references cannot cover, and `natural` is not raw MT output - it
   is produced under a prompt that also demands `literal`, so models legitimately push
   `natural` further from the source to differentiate the two. n-gram metrics punish
   that correct behaviour. COMET works in embedding space and does not.

3. Scores are only ever read as deltas against run_variance. See the top of report.md.
"""

import argparse
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

SCORING_VERSION = 1

# Checks where True means the model behaved. Everything else is a failure flag.
POSITIVE_CHECKS = {
    "jsonValid", "hasAllRequired", "naturalNonEmpty", "nuanceNonEmpty",
    "altsPresent", "altsExactlyTwo", "altsSizesValid", "altsRegistersValid",
}
FAILURE_CHECKS = ["empty", "fenced", "prosePreamble", "hanjaLeak", "salvaged", "retried"]
COMPLIANCE_ORDER = [
    "jsonValid", "hasAllRequired", "naturalNonEmpty", "nuanceNonEmpty",
    "altsExactlyTwo", "altsSizesValid", "altsRegistersValid",
    "hanjaLeak", "fenced", "prosePreamble", "salvaged", "retried", "empty",
]
# Every value in compliance_rates() is "rate the model did the right thing" (see there),
# but half the underlying keys are named after the failure they detect (hanjaLeak,
# salvaged, ...). Printing "hanjaLeak | 100.0%" reads as "100% leaked Hanja" when it means
# the opposite. Report headers use this positive-sense label instead of the raw key name;
# metrics.json keeps the raw key so it still matches compliance.js one-to-one.
COMPLIANCE_LABELS = {
    "hanjaLeak": "noHanjaLeak", "fenced": "noFence", "prosePreamble": "noPreamble",
    "salvaged": "notSalvaged", "retried": "notRetried", "empty": "nonEmpty",
}


def load_predictions(run_dir):
    path = run_dir / "predictions.jsonl"
    if not path.exists():
        sys.exit(f"No predictions.jsonl in {run_dir}")
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def load_dataset(config, bench_root):
    items = {}
    for name in config["datasets"]:
        f = bench_root / "datasets" / config["datasetVersion"] / name
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                item = json.loads(line)
                items[item["id"]] = item
    return items


# --- quality metrics ------------------------------------------------------------

def score_ngram(hyps, refs_list):
    """Corpus chrF++ and BLEU with paired-bootstrap confidence intervals.

    sacrebleu wants references transposed: a list per reference-slot, not per sentence.
    Slots are padded with the first reference so ragged reference counts are legal.
    """
    import sacrebleu

    if not hyps:
        return None
    width = max(len(r) for r in refs_list)
    transposed = [[(r[i] if i < len(r) else r[0]) for r in refs_list] for i in range(width)]

    chrf = sacrebleu.CHRF(word_order=2)  # chrF++
    bleu = sacrebleu.BLEU()
    return {
        "chrf2": round(chrf.corpus_score(hyps, transposed).score, 3),
        "bleu": round(bleu.corpus_score(hyps, transposed).score, 3),
        "n": len(hyps),
    }


def score_comet(srcs, hyps, refs, model_name="Unbabel/wmt22-comet-da", batch_size=8):
    """Reference-based COMET. Apache-2.0 and ungated.

    Note this is NOT wmt22-cometkiwi-da: that one is gated on HuggingFace and licensed
    CC-BY-NC-SA, so the reference-free branch was dropped rather than take on a
    non-commercial dependency in a project that ships publicly.
    """
    from comet import download_model, load_from_checkpoint

    model = load_from_checkpoint(download_model(model_name))
    data = [{"src": s, "mt": h, "ref": r} for s, h, r in zip(srcs, hyps, refs)]
    out = model.predict(data, batch_size=batch_size, gpus=0, progress_bar=True)
    return {
        "system": round(float(out.system_score), 4),
        "segments": [round(float(s), 4) for s in out.scores],
        "n": len(data),
    }


def bootstrap_ci(values, iterations=1000, seed=20260805, alpha=0.05):
    """Percentile bootstrap over segment scores. Seeded, so it is reproducible."""
    import random
    if len(values) < 2:
        return None
    rng = random.Random(seed)
    n = len(values)
    means = sorted(statistics.fmean(rng.choices(values, k=n)) for _ in range(iterations))
    lo = means[int(iterations * alpha / 2)]
    hi = means[int(iterations * (1 - alpha / 2)) - 1]
    return [round(lo, 4), round(hi, 4)]


# --- operational metrics --------------------------------------------------------

def percentile(sorted_vals, p):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    return round(sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo), 1)


def operational(records, config, pricing):
    lat = sorted(r["latencyMs"] for r in records)
    prompt_toks = sum((r.get("usage") or {}).get("prompt_tokens", 0) for r in records)
    completion_toks = sum((r.get("usage") or {}).get("completion_tokens", 0) for r in records)
    n = len(records)

    errors = defaultdict(int)
    for r in records:
        if r.get("error"):
            errors[r["error"]["name"]] += 1

    price = pricing.get(config["modelId"])
    cost_per_1k = None
    if price and n:
        per_item = (prompt_toks / n / 1e6) * price["inputPer1M"] + (completion_toks / n / 1e6) * price["outputPer1M"]
        cost_per_1k = round(per_item * 1000, 4)
    elif config.get("provider") == "ollama":
        cost_per_1k = 0.0

    return {
        "latencyMs": {"p50": percentile(lat, 0.50), "p90": percentile(lat, 0.90), "p99": percentile(lat, 0.99)},
        "tokens": {
            "promptTotal": prompt_toks,
            "completionTotal": completion_toks,
            "promptMean": round(prompt_toks / n, 1) if n else None,
            "completionMean": round(completion_toks / n, 1) if n else None,
        },
        "costPer1kTranslations": cost_per_1k,
        "pricesFetchedAt": price["fetchedAt"] if price else ("n/a (local)" if config.get("provider") == "ollama" else None),
        "failureRate": round(sum(errors.values()) / n, 4) if n else None,
        "errorsByType": dict(errors),
        "retryRate": round(sum(1 for r in records if r.get("retries", 0) > 0) / n, 4) if n else None,
    }


def compliance_rates(records):
    out = {}
    n = len(records)
    if not n:
        return out
    keys = set()
    for r in records:
        keys.update((r.get("compliance") or {}).keys())
    # sorted(), not set order: Python randomizes string hashes per process, so iterating
    # the set directly reorders these keys in metrics.json on every run. The file bytes
    # have to be reproducible - "score the same predictions twice, get the same file" is
    # the check that proves scoring adds no non-determinism of its own.
    for key in sorted(keys):
        hits = sum(1 for r in records if (r.get("compliance") or {}).get(key))
        # Report everything as "rate at which the model did the right thing".
        rate = hits / n if key in POSITIVE_CHECKS else 1 - (hits / n)
        out[key] = round(rate, 4)
    return out


# --- determinism ----------------------------------------------------------------

def determinism(by_run, quality_by_run):
    """Two different things, kept apart on purpose.

    A bootstrap CI measures item-sampling variance. Re-running the same config measures
    model non-determinism. They are not interchangeable, and temperature 0 does not
    eliminate the second one: batched serving stacks reorder float accumulation depending
    on batch composition, so identical inputs can yield different outputs.

    identicalOutputRate is the direct measurement - the fraction of items whose raw
    response was byte-identical across every run. If it is low, "temperature 0" is not
    buying what it looks like it is buying.
    """
    run_indices = sorted(by_run)
    if len(run_indices) < 2:
        return {"runs": len(run_indices), "note": "single run - no variance measurable"}

    raws = defaultdict(list)
    for idx in run_indices:
        for r in by_run[idx]:
            raws[r["id"]].append(r.get("raw", ""))
    complete = [v for v in raws.values() if len(v) == len(run_indices)]
    identical = sum(1 for v in complete if len(set(v)) == 1)

    result = {
        "runs": len(run_indices),
        "identicalOutputRate": round(identical / len(complete), 4) if complete else None,
    }
    for metric, per_run in quality_by_run.items():
        vals = [v for v in per_run if v is not None]
        if len(vals) >= 2:
            result[f"{metric}_stdev"] = round(statistics.stdev(vals), 4)
            result[f"{metric}_perRun"] = vals
    return result


# --- report ---------------------------------------------------------------------

def pct(x):
    return "—" if x is None else f"{x * 100:.1f}%"


def num(x, digits=2):
    return "—" if x is None else f"{x:.{digits}f}"


def write_report(m, path):
    c = m["config"]
    var = m["runVariance"]
    L = []

    L.append(f"# Benchmark report — {c['name']}\n")
    L.append("> **How to read this.** Absolute scores mean nothing; only deltas between models on")
    L.append("> the same dataset do. **If two models differ by less than 2× runVariance, treat them")
    L.append("> as tied.** COMET is the primary quality metric. chrF++/BLEU are reference-only and")
    L.append("> known to punish correct behaviour on this task — see the note under that table.\n")

    L.append("## Provenance\n")
    L.append("| | |")
    L.append("|---|---|")
    L.append(f"| model | `{c['modelId']}` ({c['provider']}) |")
    L.append(f"| temperature | {c.get('temperature')} |")
    L.append(f"| dataset | {c['datasetVersion']} — {', '.join(c['datasets'])} ({m['itemCount']} items × {var.get('runs', 1)} runs) |")
    L.append(f"| prompt hash | `{c['promptHash'][:16]}…` |")
    L.append(f"| scoring version | {m['scoringVersion']} |")
    L.append(f"| git | `{(c.get('git') or {}).get('sha', '?')[:12]}`{' **(dirty)**' if (c.get('git') or {}).get('dirty') else ''} |")
    L.append(f"| run started | {c.get('startedAt', '?')} |\n")

    L.append("## Determinism\n")
    L.append(f"- identical output across all runs: **{pct(var.get('identicalOutputRate'))}**")
    for key in [k for k in var if k.endswith("_stdev")]:
        L.append(f"- {key.replace('_stdev', '')} stdev across runs: **{num(var[key], 3)}** → tie threshold ±{num(var[key] * 2, 3)}")
    L.append("")
    L.append("> This tie threshold is measured on chrF++ only (cheap enough to run every pass;")
    L.append("> COMET at 3x the inference cost is not). It does not transfer to COMET points 1:1 -")
    L.append("> treat a COMET gap as meaningful only if it is also large relative to this chrF++")
    L.append("> noise floor, not by comparing the raw numbers.")
    L.append("")

    L.append("## Quality — COMET (primary)\n")
    if m["quality"].get("comet"):
        L.append("| segment | COMET | 95% CI |")
        L.append("|---|---|---|")
        for scope, v in m["quality"]["comet"].items():
            L.append(f"| {scope} | {num(v['system'], 4)} | {v['ci'][0]:.4f} – {v['ci'][1]:.4f} |" if v.get("ci") else f"| {scope} | {num(v['system'], 4)} | — |")
    else:
        L.append("_COMET not computed (`--no-comet`, or `unbabel-comet` not installed)._")
    L.append("")

    L.append("## Quality — chrF++ / BLEU (secondary, see caveat)\n")
    L.append("| segment | chrF++ | BLEU | n |")
    L.append("|---|---|---|---|")
    for scope, v in m["quality"]["ngram"].items():
        if v:
            L.append(f"| {scope} | {num(v['chrf2'])} | {num(v['bleu'])} | {v['n']} |")
    L.append("")
    L.append("> These are here for comparability with published KO↔EN numbers, not for deciding")
    L.append("> anything. `natural` is generated under a prompt that also demands a `literal` field,")
    L.append("> so a model that correctly makes `natural` more idiomatic scores *worse* on n-gram")
    L.append("> overlap. Korean morphology also makes BLEU's word tokenization unreliable — chrF++")
    L.append("> is character-level and is the more trustworthy of the two.\n")

    L.append("## Compliance by slice\n")
    L.append("Rates are 'model did the right thing'. Proportions stay meaningful at n=50, which is")
    L.append("why slices appear here and nowhere else.\n")
    slices = m["compliance"]["bySlice"]
    cols = [k for k in COMPLIANCE_ORDER if k in m["compliance"]["overall"]]
    headers = [COMPLIANCE_LABELS.get(k, k) for k in cols]
    L.append("| slice | n | " + " | ".join(headers) + " |")
    L.append("|---|---|" + "---|" * len(cols))
    L.append(f"| **overall** | {m['compliance']['n']} | " + " | ".join(pct(m["compliance"]["overall"].get(k)) for k in cols) + " |")
    for name in sorted(slices):
        s = slices[name]
        L.append(f"| {name} | {s['n']} | " + " | ".join(pct(s["rates"].get(k)) for k in cols) + " |")
    L.append("")

    L.append("## Cost & latency\n")
    op = m["operational"]
    L.append("| | |")
    L.append("|---|---|")
    L.append(f"| latency p50 / p90 / p99 | {op['latencyMs']['p50']} / {op['latencyMs']['p90']} / {op['latencyMs']['p99']} ms |")
    L.append(f"| mean tokens in / out | {op['tokens']['promptMean']} / {op['tokens']['completionMean']} |")
    L.append(f"| cost per 1,000 translations | {'—' if op['costPer1kTranslations'] is None else '$' + format(op['costPer1kTranslations'], '.4f')} |")
    L.append(f"| **prices as of** | **{op['pricesFetchedAt'] or 'UNKNOWN — no pricing row'}** |")
    L.append(f"| failure rate | {pct(op['failureRate'])} |")
    L.append(f"| retry rate | {pct(op['retryRate'])} |")
    if op["errorsByType"]:
        L.append(f"| errors | {', '.join(f'{k}×{v}' for k, v in op['errorsByType'].items())} |")
    L.append("")
    L.append("Latency is wall-clock around the whole `translate()` call, including the client's")
    L.append("internal retries — that is what a user experiences. Retry rate is reported separately")
    L.append("so a slow p99 caused by retries is distinguishable from a slow model.\n")

    if m.get("judge"):
        L.append("## Structured-output quality (LLM-as-judge)\n")
        L.append(f"Judge: `{m['judge']['judgeModelId']}`, {m['judge']['n']} items, binary rubric.\n")
        L.append("| criterion | pass rate |")
        L.append("|---|---|")
        for k, v in m["judge"]["rates"].items():
            L.append(f"| {k} | {pct(v)} |")
        L.append("")
        L.append("> **Judge scores may be biased and are for relative comparison between models only.**")
        L.append("> They are not comparable across judge model versions; the judge id is recorded above")
        L.append("> and in config.json for exactly that reason.\n")

    if m.get("suspectRefs"):
        L.append("## Suspect references\n")
        L.append("Lowest-scoring items for the ceiling-anchor model. When the strongest model available")
        L.append("scores badly on an item, the likeliest explanation is a wrong reference, not a wrong")
        L.append("translation. Review these by hand — it is the cheapest way to raise dataset quality.\n")
        L.append("| id | score | source | reference |")
        L.append("|---|---|---|---|")
        for s in m["suspectRefs"]:
            L.append(f"| `{s['id']}` | {num(s['score'], 4)} | {s['source'][:60]} | {s['reference'][:60]} |")
        L.append("")

    path.write_text("\n".join(L), encoding="utf-8")


# --- main -----------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True, type=Path)
    ap.add_argument("--no-comet", action="store_true", help="skip COMET (fast pass, chrF++/BLEU only)")
    ap.add_argument("--comet-model", default="Unbabel/wmt22-comet-da")
    ap.add_argument("--slice", help="dump individual outputs for one slice and exit; not a score")
    ap.add_argument("--flag-suspect-refs", action="store_true",
                    help="list the worst-scoring items; on the anchor model these are probably bad references")
    ap.add_argument("--suspect-pct", type=float, default=0.10)
    args = ap.parse_args()

    bench_root = Path(__file__).resolve().parent.parent
    config = json.loads((args.run_dir / "config.json").read_text(encoding="utf-8"))
    records = load_predictions(args.run_dir)
    dataset = load_dataset(config, bench_root)
    pricing = load_pricing(bench_root)

    if args.slice:
        dump_slice(records, dataset, args.slice)
        return

    by_run = defaultdict(list)
    for r in records:
        by_run[r.get("runIndex", 0)].append(r)

    # Quality is scored on run 0. The other runs exist to measure spread, not to be
    # averaged into a single number - averaging would hide the very variance being measured.
    primary = by_run[min(by_run)]
    scored = [r for r in primary if not r.get("error") and r.get("hypothesis")]

    def segment(recs):
        hyps = [r["hypothesis"] for r in recs]
        refs = [dataset[r["id"]]["references"] for r in recs]
        return score_ngram(hyps, refs) if hyps else None

    ngram = {"overall": segment(scored)}
    for direction in ("ko_to_en", "en_to_ko"):
        subset = [r for r in scored if r["direction"] == direction]
        if subset:
            ngram[direction] = segment(subset)

    comet_out = {}
    suspects = []
    if not args.no_comet and scored:
        try:
            res = score_comet(
                [dataset[r["id"]]["source"] for r in scored],
                [r["hypothesis"] for r in scored],
                [dataset[r["id"]]["references"][0] for r in scored],
                args.comet_model,
            )
            comet_out["overall"] = {"system": res["system"], "n": res["n"], "ci": bootstrap_ci(res["segments"])}
            seg_by_id = dict(zip((r["id"] for r in scored), res["segments"]))
            for direction in ("ko_to_en", "en_to_ko"):
                vals = [seg_by_id[r["id"]] for r in scored if r["direction"] == direction]
                if vals:
                    comet_out[direction] = {"system": round(statistics.fmean(vals), 4), "n": len(vals), "ci": bootstrap_ci(vals)}
            if args.flag_suspect_refs:
                worst = sorted(seg_by_id.items(), key=lambda kv: kv[1])[:max(1, int(len(seg_by_id) * args.suspect_pct))]
                suspects = [{"id": i, "score": s, "source": dataset[i]["source"], "reference": dataset[i]["references"][0]}
                            for i, s in worst]
        except ImportError:
            print("  unbabel-comet not installed; skipping COMET (pip install -r score/requirements.txt)", file=sys.stderr)

    # Per-run quality for the variance figure. chrF++ is used as the variance proxy
    # because it is cheap enough to recompute per run; COMET would triple inference cost.
    quality_by_run = {"chrf2": []}
    for idx in sorted(by_run):
        ok = [r for r in by_run[idx] if not r.get("error") and r.get("hypothesis")]
        s = segment(ok)
        quality_by_run["chrf2"].append(s["chrf2"] if s else None)

    # Compliance measures whether the MODEL followed instructions. A record with a
    # transport error (429, timeout, 5xx) has raw="" for infrastructure reasons, which
    # would otherwise count as "empty": true / "jsonValid": false - an outage misread as
    # the model failing to produce JSON. failureRate (in `operational`, over all attempts)
    # is where infra failures belong; compliance is scoped to responses that arrived.
    compliant_pool = [r for r in primary if not r.get("error")]
    by_slice = defaultdict(list)
    for r in compliant_pool:
        by_slice[r.get("slice", "unknown")].append(r)

    metrics = {
        "scoringVersion": SCORING_VERSION,
        "config": config,
        "itemCount": len(primary),
        "quality": {"ngram": ngram, "comet": comet_out or None},
        "compliance": {
            "n": len(compliant_pool),
            "overall": compliance_rates(compliant_pool),
            "bySlice": {k: {"n": len(v), "rates": compliance_rates(v)} for k, v in sorted(by_slice.items())},
        },
        "operational": operational(primary, config, pricing),
        "runVariance": determinism(by_run, quality_by_run),
        "judge": load_judge(args.run_dir),
        "suspectRefs": suspects or None,
    }

    (args.run_dir / "metrics.json").write_text(json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")
    write_report(metrics, args.run_dir / "report.md")
    print(f"  wrote {args.run_dir / 'metrics.json'}")
    print(f"  wrote {args.run_dir / 'report.md'}")


def load_pricing(bench_root):
    """Read the price table out of src/pricing.js.

    The table is JS because the Node runner needs it for --dry-run, and one table with
    one fetchedAt date per model beats two copies that drift apart.
    """
    import re
    text = (bench_root / "src" / "pricing.js").read_text(encoding="utf-8")
    out = {}
    for m in re.finditer(
        r"'([^']+)':\s*\{\s*inputPer1M:\s*([\d.]+),\s*outputPer1M:\s*([\d.]+),\s*fetchedAt:\s*'([^']+)'",
        text,
    ):
        out[m.group(1)] = {"inputPer1M": float(m.group(2)), "outputPer1M": float(m.group(3)), "fetchedAt": m.group(4)}
    return out


def load_judge(run_dir):
    path = run_dir / "judge.jsonl"
    if not path.exists():
        return None
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    if not rows:
        return None
    criteria = ["tipFactual", "altsDistinct", "nuanceGrounded", "naturalFluent"]
    return {
        "judgeModelId": rows[0].get("judgeModelId"),
        "n": len(rows),
        "rates": {c: round(sum(1 for r in rows if r["scores"].get(c)) / len(rows), 4) for c in criteria},
    }


def dump_slice(records, dataset, slice_name):
    """Sample dump, explicitly not a score. Per-slice quality numbers are not reported
    anywhere because n=50 cannot support them; reading the actual outputs can."""
    hits = [r for r in records if r.get("slice") == slice_name and r.get("runIndex", 0) == 0]
    if not hits:
        sys.exit(f"No items with slice '{slice_name}'")
    print(f"\n  {len(hits)} items in slice '{slice_name}' — samples, not scores\n")
    for r in hits:
        item = dataset.get(r["id"], {})
        print(f"  [{r['id']}] {r['direction']}")
        print(f"    source     {item.get('source', '?')}")
        print(f"    hypothesis {r.get('hypothesis') or '(none)'}")
        print(f"    reference  {(item.get('references') or ['?'])[0]}")
        if r.get("error"):
            print(f"    ERROR      {r['error']['name']}: {r['error']['message']}")
        bad = [k for k in FAILURE_CHECKS if (r.get("compliance") or {}).get(k)]
        missing = [k for k in sorted(POSITIVE_CHECKS) if not (r.get("compliance") or {}).get(k)]
        if bad or missing:
            print(f"    compliance {', '.join(bad + ['!' + k for k in missing])}")
        print()


if __name__ == "__main__":
    main()
