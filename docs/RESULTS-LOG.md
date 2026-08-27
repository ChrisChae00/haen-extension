# Results log — review notes and resume-ready numbers

The committed numbers live in `bench/REPORT.md`; this document organises
**"what was done, why, and what came out"** so it can be re-read later.

Detailed problem/fix records are in [ENGINEERING-LOG.md](ENGINEERING-LOG.md). Session handoffs are
in `docs/local/` (not committed): [HANDOFF.md](local/HANDOFF.md) (measurement track),
[FINETUNING.md](local/FINETUNING.md) (improvement track). The reasoning behind the harness-accuracy
calls is in [MEASUREMENT-NOTES.md](MEASUREMENT-NOTES.md).

---

## The project in one line

Haen — a Chrome extension that explains KO↔EN cultural nuance. The response is a 4-field JSON
(`natural`/`literal`/`nuance`/`alternatives`), so **translation accuracy alone cannot measure
quality**. Hence a purpose-built benchmark harness measuring five axes: translation quality, schema
compliance, latency, cost, and LLM judgement.

---

## Scale

| Item | Value |
|---|---|
| Models measured | 7 (gemini-3.7-flash, gemini-3.5-flash-lite, gpt-oss-120b, gpt-oss-20b, qwen3.6-27b, local qwen3:14b think/no-think) |
| Dataset | 212 items (FLORES-200 devtest 200 + 12 hand-written) + 40 judge-only idiom items, both directions |
| Total API calls (2026-08-22 measurement snapshot) | 3,200+ (212 × 2–3 runs per model) |
| Measurement axes | COMET · chrF++ · BLEU · 15-check compliance · latency/TTFB percentiles · cost per token · LLM-as-judge on 4 criteria |
| Paid judge verdicts (2026-08-22 snapshot) | 316 (`claude-sonnet-5`, fixed, $0.0095 each) |
| Total paid measurement cost (2026-08-22 snapshot) | ~$7.9 (OpenRouter $6.3 + Google AI Studio $1.6) |
| Harness tests (2026-08-27) | 68 passing (zero dependencies) |

---

## Numbers that can go on a resume

### 1. 60% latency cut on the local 14B, zero translation-quality loss

Decomposed the thinking budget by measurement, identified the bottleneck, removed it.

| | Before | After |
|---|---|---|
| latency p50 | 40,087 ms | **16,211 ms** (−60%) |
| **TTFB p50** | 25,144 ms | **534 ms** (−98%, 47×) |
| COMET | 0.8849 | 0.8861 (CIs overlap, no regression) |
| schema compliance (worst rule) | 100% | 99.5% |

> Re-scored on 2026-08-26 under the 15-check suite: both numbers are unchanged, and the no-think
> run's 99.5% floor is now tied by two rules (`altsSizesValid` and the new `langTagsMatchDirection`).
>
> Method: used ollama's native timing fields to separate prefill / thinking / decode → confirmed
> thinking was 59% (24s) of total latency → threaded the `reasoning_effort` option through the
> client and ran a full A/B over all 212 items. Prompt shrinking turned out to be worth at most
> 3 seconds and was dropped.

### 2. Disproved the assumption that "model size dominates translation quality"

From 14B up to 120B, the **COMET confidence intervals of all six models overlap** (0.8849–0.8932,
width 0.008, n=212). Statistically confirmed that model choice does not drive translation quality
on this task. Generation did separate them — `gemini-3.7-flash` at 0.8962 (0.890–0.902) is the
first model to break out of that overlapping band.

What did separate models was **structured-output stability** and **groundedness of the explanation**:
- gpt-oss-20b vs 120b: tied on COMET, but `jsonValid` 97.6% vs 100%, `altsExactlyTwo` 96.2% vs 100%
- LLM-as-judge `nuanceGrounded`: gemini 100%, qwen3.6-27b 91.7%, gpt-oss-120b 58.3%,
  local 14B 50% — **does not track parameter count** (27B beats 120B)

### 3. Designed for measurability itself — judge sample size chosen by statistical power

LLM-as-judge scores the same items across models, so it is a **paired comparison** and McNemar's
exact test applies. When all discordant pairs point one way, p = `2 × 0.5^k`; at the initial sample
of n=12, k=5 gives p=0.0625 — **a structure where even the best possible result cannot clear the
significance threshold**.

While growing the sample from 12 → 52, the added items were **built from idioms**: sentences where
a literal translation is obviously wrong, so the `literal` and `nuance` fields have to do real work
to be correct. Both directions × 10 items each for casual/business.

Validation of the effect: the teacher candidate's `nuanceGrounded` was an ambiguous 75% at n=12 but
settled at **95%** at n=40 — the 12-item judgement really had been sampling noise.

### 4. Purpose-built benchmark harness — 10 measurement-reliability defects found and fixed

Cases of doubting the instrument before trusting its readings. Every one was already contaminating
real data or about to:

| Defect | Symptom | Fix |
|---|---|---|
| Stream fallback overwrote TTFB | Only the items where streaming failed vanished from the statistics | Preserve the first measurement + record `streamFallbackRate` |
| Key-rotation wait mixed into latency | latency included quota waiting rather than API speed | Move the timer inside the loop |
| `minIntervalMs` was not a rate limiter | Meaningless at concurrency > 1 | Explicit throw |
| No validation of the price table | The gemini price was off by 2× | `fetchedAt` validation |
| Reasoning-response parser | **All 55 items lost `alternatives`; in 15 the translation itself was the model's thinking** | `stripThinking` + candidate parsing |
| Summary report showed 1 of 14 checks | Reported 96.2% as 100% | Show the lowest check + the check name |
| Dead key / network drop logged as item failure | **Resume skipped them — 145 items were about to be lost permanently** | A runtime failure stops the run immediately |
| Judge silently discarded truncated responses | Sample size differed per model, so comparison broke down | Retry + fixed sample |
| Hidden thinking tokens missing from billing | The cost column for reasoning models reported **half the real figure** | Back out `total − prompt − completion` and add it to the output charge |
| The fix for that clamped a missing total to zero | 10 of 424 `gemini-3.7-flash` records read as "thought nothing" when the provider just never sent a total | Prefer the explicit field; derive only when `total_tokens` exists; record `null`, not `0`, otherwise — and mark the run's cost a lower bound |

**The shared lesson**: without distinguishing whether a failure is "a property of this item" or
"a property of the runtime", one outage disguises itself as 145 measurements.

### 5. Re-scored the published table instead of leaving a code fix undisclosed

Fixing defect #10 above only changed code; the report still showed every model's cost in one column
with no way to tell which had thinking folded in. Re-scored all eight runs against their stored
`predictions.jsonl` — no new API calls, COMET/chrF++/BLEU/compliance came back byte-identical
(bootstrap CI is seeded) — and regenerated `bench/REPORT.md`. Four pre-fix rows
(`gemini-3.5-flash-lite`, `gpt-oss-120b`, `gpt-oss-20b`, `qwen3.6-27b`) now carry `≥` on cost, and
`gemini-3.7-flash`'s own $3.0176 is disclosed as a ~4% floor for the ten unrecoverable records —
`total_tokens` was never persisted for them, so re-running is the only way to close the gap and it
was judged not worth it for 4%.

### 6. A hand review that found what four automated instruments could not

Twenty frozen idiom items, read against the product baseline's own output before any tuned model
existed. **12 pass, 8 fail.** COMET scores `natural` against a reference and cannot see an idiom
rendered literally; compliance counts the alternatives and never reads them; the LLM judge asks whether
the alternatives differ from each other, not whether they mean what the source means. So `걔는 귀가
얇아` → "She has thin ears" passes every automated check in the project.

The pattern is the useful part: on three of the five casual-idiom failures the model's own `nuance` or
`literal` field states the idiom's real meaning while `natural` renders it word-for-word — the
knowledge is present and only the output field is wrong — and both business-register failures have a
correct `natural` with a casual alternative that reverses the speech act. 12/20 also lands close to the
judge's independently measured 70% `naturalFluent` on the full 40.

### 7. Cost optimisation — 80% more free-tier budget

Measured and confirmed that Groq deducts against the request's `max_tokens` reservation, not actual
usage. Using the completion-token distribution across all models (p99 499, max 581) as evidence,
lowered the cap from 2048 → 768: daily throughput 70 → 126 calls (+80%).

Measured that OpenRouter's default routing means cheapest = slowest (gpt-oss-120b: 34.5s vs 2.4s
pinned to Groq) and implemented a provider-pin option — blocking latency from being contaminated by
broker routing rather than model behaviour.

---

## Methodology that was held to (the parts explainable in an interview)

- **Frozen eval set**: FLORES `devtest` split + fixed seed. Training data is drawn only from the
  `dev` split, guaranteeing structural zero overlap (not yet executed; the rule is settled)
- **Reproducibility**: every run records `promptHash` / `datasetChecksums` / git sha / model id.
  Differing hashes are flagged as not comparable
- **The danger of a single number**: compliance in the summary table is the **lowest of the 15 implemented
  checks plus the check name**. An average, or one representative check, lies for as long as perfect scores
  keep coming. The 15th (`langTagsMatchDirection`, added 2026-08-26) is what a "plus the check name" column
  is for: it caught a baseline item that emits the language tags exactly reversed on all three runs, which
  every other instrument — COMET included — is blind to
- **Fixed judge**: LLM-as-judge uses the same model, the same rubric hash, and the same 12 items
  across all 5 runs. If judges are mixed, the report prints "not comparable"
- **Known limitations stated in the report**: judge n=12, dirty-git-tree flag

---

## Not done yet (honestly)

- LoRA fine-tuning has not started, so **no tuning win has been published and none can be**. Six of the
  seven pre-evaluation blockers were closed in code on 2026-08-26 — comparability, complete-sample and
  payload-hash ([§7.1](ENGINEERING-LOG.md#71-the-blockers-that-were-code-fixed-2026-08-26)), then
  `/no_think` provenance in `promptHash`, the direction-aware language-tag check, and the frozen 20-ID
  manual list ([§7.2](ENGINEERING-LOG.md#72-three-more-blockers-closed-2026-08-26)). The 20 item-level
  verdicts were recorded on 2026-08-27, before any tuned output exists
  ([§7.3](ENGINEERING-LOG.md#73-the-manual-gate-reviewed-2026-08-27)): the baseline scores **12 pass /
  8 fail**, and the file carries the caveat that an LLM filled a gate meant to be the non-LLM check.
  Still open: the **same-serving untuned control run**, which needed the `/no_think` setting it now has.
