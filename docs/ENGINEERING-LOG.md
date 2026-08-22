# Engineering log — problem · cause · fix · result

The record of **what went wrong in this project and how it was fixed**. Work in progress and next
steps live in `docs/local/HANDOFF.md` (not committed), the outcome summary in
[RESULTS-LOG.md](RESULTS-LOG.md), and the source of the latest numbers in `bench/REPORT.md`.

Grouped **by kind of problem**, not chronologically. To avoid repeating a mistake, what kind of
mistake it was matters more than when it happened.

---

## 1. When the instrument lied (9 cases)

Cases where the benchmark itself had to be doubted before its conclusions could be trusted. Every
one of them **exited cleanly, and the result files looked fine**. That is why tests did not catch them.

### 1.1 Stream fallback overwrote TTFB

- **Symptom**: for items where streaming failed and was retried, TTFB was recorded as `null`
- **Cause**: on stream failure `apiClient` re-issues the call once more without `onChunk`. The
  second response's `ttfbMs: null` overwrote the first measurement
- **Why it is dangerous**: exactly the items where streaming misbehaved disappear from the TTFB
  statistics — that is, **the slowest items silently drop out and the average improves**
- **Fix**: preserve the first measurement and record `streamFallbackRate` as a separate metric
- **Result**: every run since confirms a fallback rate of 0.0. The size of the bias in the old
  gemini run was retroactively established as zero too

### 1.2 Key-rotation wait mixed into latency

- **Cause**: the wait while moving to the next key after quota exhaustion sat inside the
  `latencyMs` timer
- **Fix**: moved the timer start inside the retry loop
- **Lesson**: latency has to mean "how long the model takes". Once harness circumstances are mixed
  in, it is not a model comparison any more

### 1.3 `minIntervalMs` was not a rate limiter

- **Cause**: it was a sleep between items, so at `concurrency > 1` it limited nothing
- **Fix**: throw if concurrency is greater than 1. Better to die loudly than to be quietly wrong

### 1.4 No validation of the price table

- **Symptom**: the `gemini-3.6-flash` price was recorded at twice the real value
- **Fix**: attach `fetchedAt` to every price row and print it in the report. Rows that cannot be
  verified **do not get their date bumped** — an old date is information, a wrong date is contamination

### 1.5 Reasoning-model response parser — the biggest incident

- **Symptom**: 55 `qwen3.6-27b` responses had `alternatives` entirely empty, and in 15 of them
  `natural` contained **sentences of the model's thinking process**
- **Two causes**:
  1. greedily matching `{ ... }` without stripping the `<think>` block → braces inside the thinking
     got mixed in
  2. when the response was truncated, the salvage logic pulled `"natural": "..."` **out of the
     model's scratchpad**
- **Fix**: added `stripThinking()`. To also catch the untagged case (the qwen3.6 that Alibaba serves
  leaks its thinking as plain text), candidate start positions are tried in order and the **first
  candidate that parses into a real object with a `natural` field** is taken. `parsePartial` uses
  the **last** match rather than the first (the sketch comes first and the real answer later)
- **Result**: re-parsed all 848 stored raw responses with the new parser and diffed — the two
  gpt-oss runs were unaffected (`naturalDiffers=0`). The bug had been hitting extension users too
- **Lesson**: **when starting to measure a reasoning model on a new provider, look at one raw
  response with your own eyes.** Looking only at `parsed`, salvaged garbage looks fine

### 1.6 The summary report was looking at 1 of 15 rules

- **Symptom**: `gpt-oss-20b` had `jsonValid` 97.6% but the table showed compliance **100%**
- **Cause**: the summary column read only `hasAllRequired`, the easiest of the 15 rules to pass.
  The first three models were all perfect, so it went unnoticed for three runs
- **Fix**: display **the lowest of the 15 rules plus that rule's name** (`96.2% (altsExactlyTwo)`)
- **Side effect**: `gemini-3.5-flash-lite` was corrected from 100% → **99.5% (noHanjaLeak)**
- **Lesson**: when folding several metrics into one, **make the folding function visible in the
  name**. "Compliance" reads as all 15 rules but was actually 1, and while perfect scores keep
  coming nobody can tell

### 1.7–1.8 Runtime failures logged as item failures (same shape, happened three times)

All three times the same shape: **runtime failure → the remaining items become error rows within
milliseconds → resume skips the rows already on disk → permanent contamination**.

| Occurrence | Trigger | Damage |
|---|---|---|
| 1st | 401 from the OpenRouter key's **weekly spend limit** (separate from balance) | qwen 384/424, gpt-oss 350/424 became error rows |
| 2nd | Burst of 429s from the Alibaba upstream | Each resume did 1–3 items and stopped |
| 3rd | **Network dropped** overnight | **145 of 424 items about to be lost** |

- **Fix**:
  - promote `InvalidKeyError` (dead key) to `AllKeysExhausted` so the run halts immediately
  - added `NetworkGone` — **10 consecutive fetch failures stop the run itself.** A model cannot
    become unreachable 10 times in a row on its own, so that is one outage, not 145 measurements
  - HTTP 5xx is excluded — the connection got through, so that is a measurement of the provider,
    not a broken link
  - unified the halt decision from class-name comparison to an **`e.fatal` flag**
- **Recovery**: filtered out the error rows and resumed. On the third occurrence one duplicate row
  was also removed, leaving a clean 424
- **Lesson (the most expensive one in this project)**: when meeting a new failure mode, ask first —
  **is this a property of this item, or a property of the runtime?** If the latter, do not record it;
  stop.

### 1.9 Hidden thinking tokens missing from billing

- **Symptom**: the OpenAI-compatible response from `gemini-3.7-flash` reported
  `prompt 23 + completion 592` but `total 1522`
- **Cause**: Google **bills thinking tokens as output but leaves them out of `completion_tokens`**.
  Cross-checked against the native API's `thoughtsTokenCount`
- **Fix**: back out `total − prompt − completion` (`reasoning_tokens`) and add it to the output
  charge. Models that do not hide anything yield 0, so existing rows are unaffected
  (`gemini-3.5-flash-lite`: 23+451=474)
- **Result**: 3.7-flash cost/1k corrected from $1.7 → **$3.02**. The teacher-data budget had nearly
  been set at half of what it should be

### Shared lessons

1. **A clean exit is not evidence of correctness.** Zero of the 9 cases above produced a crash
2. Where a failure is recorded determines the lifetime of the data. In a system with resume logic,
   **a wrongly recorded failure is permanent**
3. When folding metrics into one, make the folding visible in the name, and use the worst value

---

## 2. Disproved hypotheses

The point of measuring was not to confirm hypotheses but to kill wrong ones quickly.

### 2.1 "Translation quality is dominated by parameter count" — disproved

From 14B (local Q4) to 120B, **the COMET confidence intervals of all six models overlap**
(0.8849–0.8932, width 0.008, n=212). Model choice does not drive translation quality on this task.

Generation did separate them — `gemini-3.7-flash` at 0.8962 (0.890–0.902) is the first model to
break out of that overlapping band. **Not size, but generation.**

### 2.2 "Compliance is where fine-tuning will pay off" — disproved

Before any tuning the local 14B was already at **100% on all 15 rules, 0 Hanja leaks out of 636**.
There was nothing to raise. The evidence for this hypothesis — `llama-3.3-70b`'s `noHanjaLeak` at
66.7% — was **a defect of that one model**, not a general size-independent phenomenon.

### 2.3 "Explanation quality follows size too" — disproved

LLM-as-judge `nuanceGrounded`: `qwen3.6-27b` 91.7% > `gpt-oss-120b` 58.3%. A 27B from the same Qwen
family beats a 120B. If the gap were one size could close, the 120B would sit in the middle. It is
**a post-training difference**, which is what led to the conclusion that LoRA can touch it.

### 2.4 "The main culprit for latency is the 1,365-token prompt" — disproved

Decomposing with ollama's native timings showed that of 43 seconds **prefill was only 3.2s** while
**thinking was 23.9s (59%)** and decode 17.1s. Prompt shrinking is at most a 3-second card, not
worth breaking `promptHash` over. **Picking an optimisation target without measuring would have
meant digging here.**

---

## 3. Performance work — the thinking budget

**Problem**: latency p50 of 40 seconds on the local 14B. Unusable as side-panel UX.

**Measurement**: ollama's native `/api/chat` reports prefill and decode separately (the
OpenAI-compatible path does not). Thinking tokens are not in `eval_count`, so the unaccounted
interval `total − load − prompt_eval − eval` is exactly the thinking.

**Finding a lever** — there is exactly one way to turn thinking off on ollama's OpenAI-compatible
endpoint:

| Attempt | Result |
|---|---|
| `/no_think` in the system prompt | Ignored |
| `"think": false` in the body | Ignored |
| **`"reasoning_effort": "none"`** | **Works** |

The option is threaded through the same way as `providerRouting` — when the value is absent the
field is not sent, so **the request body the extension sends is byte-identical**.

**Result** (212 items, same `promptHash` and `datasetChecksums`):

| | thinking on | thinking off |
|---|---|---|
| latency p50 | 40,087 ms | **16,211 ms** |
| TTFB p50 | 25,144 ms | **534 ms** (47×) |
| COMET | 0.8849 (0.877–0.892) | 0.8861 (0.878–0.893) |
| compliance, lowest of 15 rules | 100% | 99.5% (1 item each on 2 rules) |
| judge `tipFactual` | 91.7% | 66.7% (n=12) |

**What thinking was protecting was neither translation quality nor schema compliance but the
groundedness of `tip`/`nuance`. And the price of that was 24 seconds.** This result changed the
tuning goal from "get nuance to 27B level" to **"as good as thinking, without thinking"**.

---

## 4. What the cost structure revealed

| Finding | Detail | Response |
|---|---|---|
| Groq bills by **reservation** | Deducts the request's `max_tokens` from TPD/TPM, not actual usage | Measured the completion distribution across all models (p99 499, max 581) → cap 2048 → 768. Daily 70 → **126 calls (+80%)** |
| OpenRouter default routing = **cheapest = slowest** | gpt-oss-120b on CoreWeave 34.5s vs pinned to Groq 2.4s | Pin the backend with `providerRouting`. `allow_fallbacks: false` (with fallbacks on, the latency distribution becomes a mixture of two stacks) |
| Why first-party serving | Third parties usually quantise to fp8/int8 | qwen3.6-27b pinned to Alibaba. Recorded in the report for the same reason the local model is stated as Q4_K_M |
| Gemini free tier has **per-project quota** | 3.7-flash 20 RPD (3.5-flash-lite 500) — 11 days for 212 items | More keys on the same project change nothing. Solved with pay-as-you-go (212×2 ≈ $1.6) |
| Thinking tokens billed as output | See 1.9 above | Back out `reasoning_tokens` |

---

## 5. Rules settled in the methodology

- **Frozen eval set** — FLORES `devtest` split + fixed seed 20260805. Training data comes only from
  the `dev` split, guaranteeing structural zero overlap. Without this, "our model beat a commercial
  one" is just a leaked exam paper
- **Three reproducibility fields** — every run records `promptHash` / `datasetChecksums` / git sha,
  and runs measured on a dirty tree are flagged in the table. If any one differs, it is not comparable
- **Fixed judge** — LLM-as-judge uses the same model, the same rubric hash and the same items across
  all runs. If they are mixed, the report prints "not comparable"
- **Sample size is set by statistical power** — the judge scores the same items across models, so it
  is a paired comparison (McNemar), and the exact p-value when every discordant pair points one way
  is `2 × 0.5^k`. At n=12, k=5 gives 0.0625, so **even the best possible result cannot clear the
  significance threshold**. Growing the sample 12 → 52 was not a precision problem but a problem of
  **measurability itself**
- **The idiom set is judge-only** — a correct translation of an idiom does not overlap the reference
  on the surface, so COMET drops to 0.8336 (FLORES 0.896). Different metrics want different data
- **Teachers are wrong too** — the chosen teacher `gemini-3.7-flash` scores `altsDistinct` 82.5%
  (casual 15/20). The judge's notes pinpointed the cause: alternatives listed in the source language,
  and two categories at the same register. **Wrong outputs have to be filtered out of the training
  data** — whatever is learned comes back out

---

## 6. Project progression summary

| Stage | Detail |
|---|---|
| Phase 0–5 (2026-07) | Extension implementation — i18n, storage, streaming, caching, retries, 3 providers |
| Design overhaul (2026-07-28~) | Move to the Side Panel, role-based colour tokens (AA 4.5:1 enforced), 3-way theme |
| Bench harness (2026-08-05~) | Zero-dependency Node harness. Drives the extension's `TranslatorAPI` directly so it **measures the real user path** |
| Measurement (~2026-08-19) | 5 models × 212 items. 2 hypotheses disproved, 8 instrument defects fixed |
| Speed (2026-08-21) | Latency decomposition → thinking removed → latency −60%, TTFB −98% |
| Teacher selection (2026-08-22) | gemini-3.7-flash measured and judged → chosen. Judge sample grown 12 → 52 |
| Next | LoRA distillation — "as good as thinking, without thinking" |
