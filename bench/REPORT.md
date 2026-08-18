# Haen Benchmark Report — Consolidated Results

> Measured from `bench/results/*/metrics.json`. Every number below traces back to a
> real run - see the `git sha` / `prompt hash` columns to reproduce it.

Benchmarked **1 model(s)**: gemini-3.5-flash-lite.

## Model Benchmark Comparison Matrix

| Model | Provider | n (items × runs) | Compliance | COMET (95% CI) | chrF++ | Latency (p50/p90/p99) | Streaming TTFB (p50) | Cost / 1k | Prices as of |
|---|---|---|---|---|---|---|---|---|---|
| **gemini-3.5-flash-lite** | `google` | 212 × 2 | 100.0% | 0.8926 (0.886–0.899) | 48.43 | 1620.5 / 1929.2 / 2264.1 ms | 573.0 ms | $0.9513 | 2026-08-09 |

## Determinism & Reproducibility

| Model | identical output rate | chrF++ stdev (tie threshold) | failure rate | retry rate | git sha | prompt hash |
|---|---|---|---|---|---|---|
| gemini-3.5-flash-lite | 0.0% | 0.138 (±0.276) | 0.0% | 0.0% | `7977a87825fc` | `3d18dda71bc9…` |

> **How to read this.** Absolute scores mean nothing; only deltas between models do.
> If two models' COMET scores differ by less than 2× the chrF++ stdev (tie threshold
> column above), treat them as tied - that's the noise floor from re-running the same
> config, not a real quality gap.

