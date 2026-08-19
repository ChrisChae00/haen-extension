# Haen Benchmark Report — Consolidated Results

> Measured from `bench/results/*/metrics.json`. Every number below traces back to a
> real run - see the `git sha` / `prompt hash` columns to reproduce it.

Benchmarked **4 model(s)**: gemini-3.5-flash-lite, gpt-oss-120b, gpt-oss-20b, qwen3-14b-local.

## Model Benchmark Comparison Matrix

| Model | Provider | n (items × runs) | Compliance (worst rule) | COMET (95% CI) | chrF++ | Latency (p50/p90/p99) | Streaming TTFB (p50) | Cost / 1k | Prices as of |
|---|---|---|---|---|---|---|---|---|---|
| **qwen3-14b-local** | `ollama` | 212 × 3 | 100.0% (altsExactlyTwo) | 0.8849 (0.877–0.892) | 47.47 | 40086.5 / 53579.4 / 71656.3 ms | 25143.5 ms | $0.0000 | n/a (local) |
| **gemini-3.5-flash-lite** | `google` | 212 × 2 | 99.5% (noHanjaLeak) | 0.8918 (0.885–0.897) | 48.56 | 1559.0 / 1788.9 / 2015.9 ms | 567.5 ms | $0.9527 | 2026-08-18 |
| **gpt-oss-120b** | `openrouter` | 212 × 2 | 100.0% (altsExactlyTwo) | 0.8932 (0.886–0.899) | 48.60 | 2196.5 / 3272.0 / 4688.5 ms | 1486.5 ms | $0.6205 | 2026-08-18 |
| **gpt-oss-20b** | `openrouter` | 212 × 2 | 96.2% (altsExactlyTwo) | 0.8883 (0.881–0.895) | 48.28 | 1477.0 / 2456.9 / 4401.3 ms | 1212.0 ms | $0.3812 | 2026-08-18 |

## Determinism & Reproducibility

| Model | identical output rate | chrF++ stdev (tie threshold) | failure rate | retry rate | git sha | prompt hash |
|---|---|---|---|---|---|---|
| qwen3-14b-local | 100.0% | 0.000 (±0.000) | 0.0% | 0.0% | `61c2d7f42f65` | `3d18dda71bc9…` |
| gemini-3.5-flash-lite | 0.0% | 0.431 (±0.863) | 0.0% | 0.0% | `605c26d89eef` | `3d18dda71bc9…` |
| gpt-oss-120b | 0.0% | 0.072 (±0.144) | 0.0% | 0.0% | `bbf73e1a308e` | `3d18dda71bc9…` |
| gpt-oss-20b | 7.5% | 0.098 (±0.197) | 0.5% | 3.8% | `8e672b2857b2` | `3d18dda71bc9…` |

> **How to read this.** Absolute scores mean nothing; only deltas between models do.
> If two models' COMET scores differ by less than 2× the chrF++ stdev (tie threshold
> column above), treat them as tied - that's the noise floor from re-running the same
> config, not a real quality gap.

