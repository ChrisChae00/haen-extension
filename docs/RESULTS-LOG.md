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
| Paid judge verdicts | 476 (`claude-sonnet-5`, fixed) — 316 at the 2026-08-22 snapshot, +40 untuned control 2026-08-27, +82 absolute and +38 pairwise on the two unfused arms 2026-08-28 |
| Total paid measurement cost | ~$11.5 (OpenRouter $9.90 + Google AI Studio $1.6) as of 2026-08-28; $7.9 at the 2026-08-22 snapshot. The OpenRouter grant is exhausted, which stopped the pairwise sign test at 17 of 40 items |
| Fine-tuning run (2026-08-27) | QLoRA rank 8 / top 8 layers on Qwen3-14B-4bit, 896 distilled samples, 224 updates, 6h08m local, peak 15.6 GB of 24 GB; holdout loss 1.566 → 0.859 |
| Harness tests (2026-08-27) | 70 passing (zero dependencies) |

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

### 7. Built the control that says whether a tuning result is real

The tuned model would not have differed from the product baseline by weights alone: different runner,
different quantisation, different template. So before tuning anything, built the model that isolates
it — the base weights through the *entire* pipeline, fused with a zero-initialised LoRA adapter, which
is provably an identity operation.

It paid for itself on its first run. **31 of 40 outputs differ from the product baseline with
mathematically identical weights** — the serving path alone rewrites 78% of the idiom set. It also
scores 100% on all 15 compliance checks where the baseline leaks Hanja on one item, and runs faster
(p50 9,089 ms vs 10,931 ms). Every one of those differences would otherwise have been attributed to
fine-tuning.

The judge made it sharper still. Scored by the same fixed `claude-sonnet-5` rubric, `tipFactual` falls
70.0% → 50.0% and **20 of 40 items flip verdict** — with identical weights. Even `naturalFluent`,
which barely moves in aggregate (70.0% → 72.5%), flips nine items. **A net rate hides the churn
underneath it**, which is why the success criterion is an item-paired sign test and not a difference
of percentages. It also meant two of the pre-registered regression thresholds were anchored to the
wrong model: a tuned candidate that changed nothing would have failed them.

The same run exposed a compliance check that measured the transport instead of the model: `/no_think`
emits an empty `<think></think>`, the body stopped starting with `{`, and `prosePreamble` read 0/40.
Since the summary column reports the worst rule, the tuning track was one run away from publishing
itself at 0% compliance for a reason that had nothing to do with any model.

And it settled a methodology question by **refusing to compute a statistic**: the tuned-vs-product
comparison does not share a transport, so it is reported as descriptive win/loss/tie counts with no
p-value, and significance is claimed only against the control. The alternative — an override flag on
the comparability gate — would have turned a guard into a suggestion.

### 8. Cost optimisation — 80% more free-tier budget

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

- **No tuning win has been published, and none can be yet.** The first QLoRA run finished on
  2026-08-27 (rank 8 over the top 8 layers, 896 distilled samples, 224 optimizer updates,
  6h08m local, holdout loss 1.566 → 0.859). It was fused, served, and measured, and it failed
  a hard regression gate: `altsExactlyTwo` 100% → **22.5%**. The cause is not the training.
  Served with the adapter applied at inference, every checkpoint obeys the rule; fused into
  the checkpoint, the same weights do not — and they fail identically inside MLX and inside
  Ollama, so it is the fuse rather than the importer. The mechanism is that the LoRA delta
  (mean 2.81e-4) is the size of the int4 re-quantisation's own rounding error (2.6e-4), so
  re-quantising rounds the learned change away instead of carrying it through
  ([§7.7](ENGINEERING-LOG.md#77-the-fuse-destroyed-what-the-training-learned-2026-08-27)).
  The paid judge was held back from that run — judging there would have scored a model the fuse
  had corrupted and reported it as a fine-tuning result.
- **The unfused comparison ran, and the target criteria did not improve.** Both arms were
  re-served through `mlx_lm.server`, which turned out to accept `--adapter-path` and ignore it
  — caught because the two arms came back byte-identical in all four scored fields across 40
  items ([§7.8](ENGINEERING-LOG.md#78-a-flag-that-was-accepted-and-ignored-caught-by-two-arms-that-agreed-too-well-2026-08-28)).
  With that fixed and verified behaviourally, the absolute judge on n=40 gives `naturalFluent`
  75.0% → 70.0%, `nuanceGrounded` 27.5% → 30.0%, `altsDistinct` 50.0% → 55.0%, `tipFactual`
  62.5% → 50.0%. The two criteria this track exists to improve did not improve. Compliance
  regressed by one item (`altsExactlyTwo` 100% → 97.5%, a malformed JSON object).
- **The primary criterion has not run.** The item-paired pairwise sign test needs both A/B
  orders on all 40 items and stopped at 17 when the OpenRouter grant ran out; the completeness
  gate refused to emit a p-value on a partial subset, and the partial counts are not quoted
  because the finished items are the first by dataset order, not a random sample. Resuming
  costs about $0.44. Until it runs there is no verdict — the absolute rates are the secondary
  criterion precisely because they hide the item-level churn (10–15 items flip on every
  criterion here), and reading a verdict off them would be the substitution the sign test
  exists to prevent.
- **The untuned control exists and is measured** (2026-08-27), which closed the last of the
  seven pre-evaluation blockers. It immediately earned its cost: with weights mathematically
  identical to the product baseline, 31 of 40 `natural` outputs differ, and the absolute
  judge moved `tipFactual` from 70.0% to 50.0% with 20 of 40 items flipping. Every one of
  those deltas would otherwise have been credited to LoRA. Regression thresholds were
  re-anchored to the control as a result, because the baseline's values would have failed a
  candidate that changed nothing.
- **Two comparison decisions are deliberately unmade.** COMET's confidence-interval floor is
  a 212-item number while the control was only run on the 40 idiom items, so a 212-item
  control run is required before the candidate is evaluated at that size. And the frozen
  manual-20 verdicts were recorded against product-baseline outputs, which differ from the
  control's on 31 of 40 items — so whether that gate compares the candidate to the baseline
  or to the control has to be settled, not guessed.
- **Significance is claimed for one comparison only.** Tuned vs untuned control gets the
  sign test. Tuned vs the shipped `qwen3:14b` is reported as descriptive win/loss/tie counts
  with no p-value computed or quoted, because the two differ in runner, quantisation, and
  template as well as weights. The reasoning, and the two alternatives rejected, are in
  [MEASUREMENT-NOTES §9](MEASUREMENT-NOTES.md#9-refusing-to-compute-a-statistic-2026-08-27).
- **The manual 20-item gate was filled by an LLM**, which is what it was meant not to be. The
  frozen file records that caveat alongside the 12 pass / 8 fail result. A human should re-read
  at least the 8 failures before any tuning claim leans on it.
