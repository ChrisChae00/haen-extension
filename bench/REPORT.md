# Haen Benchmark Report — Consolidated Results

> Measured from `bench/results/*/metrics.json`. Every number below traces back to a
> real run - see the `git sha` / `prompt hash` columns to reproduce it.

Benchmarked **7 model(s)**: gemini-3.5-flash-lite, gemini-3.7-flash, gpt-oss-120b, gpt-oss-20b, qwen3-14b-local, qwen3-14b-local-nothink, qwen3.6-27b.

> **1 run(s) sit outside this matrix** (`gemini-3.7-flash-ext` on handbuilt-ext.jsonl). They were measured on a different dataset, so their COMET and compliance numbers answer a different question and are not model rows. They appear in the judge table below, where the `n` column says what each was scored on.

## Model Benchmark Comparison Matrix

| Model | Provider | n (items × runs) | Compliance (worst rule) | COMET (95% CI) | chrF++ | Latency (p50/p90/p99) | Streaming TTFB (p50) | Cost / 1k | Prices as of |
|---|---|---|---|---|---|---|---|---|---|
| **qwen3-14b-local** | `ollama` | 212 × 3 | 100.0% (altsExactlyTwo) | 0.8849 (0.877–0.892) | 47.47 | 40086.5 / 53579.4 / 71656.3 ms | 25143.5 ms | $0.0000 | n/a (local) |
| **gemini-3.5-flash-lite** | `google` | 212 × 2 | 99.5% (noHanjaLeak) | 0.8918 (0.885–0.897) | 48.56 | 1559.0 / 1788.9 / 2015.9 ms | 567.5 ms | $0.9527 ≥ | 2026-08-18 |
| **gpt-oss-120b** | `openrouter` | 212 × 2 | 100.0% (altsExactlyTwo) | 0.8932 (0.886–0.899) | 48.60 | 2196.5 / 3272.0 / 4688.5 ms | 1486.5 ms | $0.6205 ≥ | 2026-08-18 |
| **qwen3.6-27b** | `openrouter` | 212 × 2 | 54.2% (noPreamble) | 0.8918 (0.884–0.898) | 47.05 | 52284.5 / 67880.9 / 89652.0 ms | 36438.0 ms | $10.9397 ≥ | 2026-08-18 |
| **gpt-oss-20b** | `openrouter` | 212 × 2 | 96.2% (altsExactlyTwo) | 0.8883 (0.881–0.895) | 48.28 | 1477.0 / 2456.9 / 4401.3 ms | 1212.0 ms | $0.3812 ≥ | 2026-08-18 |
| **qwen3-14b-local-nothink** | `ollama` | 212 × 3 | 99.5% (altsSizesValid) | 0.8861 (0.878–0.893) | 47.59 | 16210.5 / 22028.9 / 25389.3 ms | 534.0 ms | $0.0000 | n/a (local) |
| **gemini-3.7-flash** | `google` | 212 × 2 | 100.0% (altsExactlyTwo) | 0.8962 (0.890–0.902) | 49.98 | 3717.0 / 6321.7 / 10630.1 ms | 2796.5 ms | $3.0176 | 2026-08-21 |

> **`≥` marks a cost that excludes thinking tokens** (gemini-3.5-flash-lite, gpt-oss-120b, gpt-oss-20b, qwen3.6-27b). Those runs predate `reasoning_tokens`, or the provider returned no `total_tokens` to derive it from, so hidden thinking was billed at zero. On `gemini-3.7-flash` that same omission understated the cost by roughly half - do not rank models on a column that mixes marked and unmarked rows without re-running the marked ones. An unmarked row is not automatically exact either: a run recorded before `null` replaced the clamped `0` can hold items that were never measured and cannot now say so, which makes `gemini-3.7-flash`'s own $3.0176 a ~4% floor as well (docs/MEASUREMENT-NOTES.md 5).

> **Thinking budget was requested, not verified**, on: qwen3-14b-local-nothink (`none`). `reasoning_effort` is sent in the request body and a backend that ignores it returns a normal response, so treat the latency drop as the evidence the lever landed - not the run name.

## Determinism & Reproducibility

| Model | identical output rate | chrF++ stdev (tie threshold) | failure rate | retry rate | git sha | prompt hash |
|---|---|---|---|---|---|---|
| qwen3-14b-local | 100.0% | 0.000 (±0.000) | 0.0% | 0.0% | `61c2d7f42f65` | `3d18dda71bc9…` |
| gemini-3.5-flash-lite | 0.0% | 0.431 (±0.863) | 0.0% | 0.0% | `605c26d89eef` **(dirty)** | `3d18dda71bc9…` |
| gpt-oss-120b | 0.0% | 0.072 (±0.144) | 0.0% | 0.0% | `bbf73e1a308e` **(dirty)** | `3d18dda71bc9…` |
| qwen3.6-27b | 0.0% | 0.316 (±0.632) | 0.0% | 0.0% | `05a099062cca` **(dirty)** | `3d18dda71bc9…` |
| gpt-oss-20b | 7.5% | 0.098 (±0.197) | 0.5% | 3.8% | `8e672b2857b2` **(dirty)** | `3d18dda71bc9…` |
| qwen3-14b-local-nothink | 100.0% | 0.000 (±0.000) | 0.0% | 0.0% | `a7daa694e78c` **(dirty)** | `3d18dda71bc9…` |
| gemini-3.7-flash | 0.0% | 0.400 (±0.800) | 0.0% | 0.0% | `a7daa694e78c` | `3d18dda71bc9…` |

> **These rows were not all measured by the same code.** 6 distinct git sha(s) across 7 run(s); dirty working tree for gemini-3.5-flash-lite, gpt-oss-120b, gpt-oss-20b, qwen3-14b-local-nothink, qwen3.6-27b. A dirty tree means the recorded sha is a lower bound, not the code that ran.
> Before reading a cross-model delta off this table, check that no run predates
> a change to the parsing, request, or scoring path - and re-run the ones that do.

> **How to read this.** Absolute scores mean nothing; only deltas between models do.
> If two models' COMET scores differ by less than 2× the chrF++ stdev (tie threshold
> column above), treat them as tied - that's the noise floor from re-running the same
> config, not a real quality gap.

## Structured-output quality (LLM-as-judge)

| Model | n | naturalFluent | nuanceGrounded | altsDistinct | tipFactual |
|---|---|---|---|---|---|
| qwen3-14b-local | 12 | 91.7% | 50.0% | 58.3% | 91.7% |
| gemini-3.5-flash-lite | 12 | 100.0% | 100.0% | 41.7% | 91.7% |
| gpt-oss-120b | 12 | 91.7% | 58.3% | 58.3% | 100.0% |
| qwen3.6-27b | 12 | 100.0% | 91.7% | 91.7% | 83.3% |
| gpt-oss-20b | 12 | 91.7% | 58.3% | 33.3% | 91.7% |
| qwen3-14b-local-nothink | 12 | 100.0% | 41.7% | 50.0% | 66.7% |
| gemini-3.7-flash | 12 | 100.0% | 75.0% | 83.3% | 100.0% |
| gemini-3.7-flash-ext | 40 | 100.0% | 95.0% | 82.5% | 97.5% |

> Judge: `anthropic/claude-sonnet-5`, binary rubric. **Rows are not all scored on the same items** - read the `n` column, and compare only rows that share it.
> Judge scores carry the judge's own biases and are for relative comparison
> between the models in this table only.

