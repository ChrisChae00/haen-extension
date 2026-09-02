# Engineering log — problem · cause · fix · result

The record of **what went wrong in this project and how it was fixed**. Work in progress and next
steps live in `docs/local/HANDOFF.md` (not committed), the outcome summary in
[RESULTS-LOG.md](RESULTS-LOG.md), and the source of the latest numbers in `bench/REPORT.md`.

Grouped **by kind of problem**, not chronologically. To avoid repeating a mistake, what kind of
mistake it was matters more than when it happened.

---

## 1. When the instrument lied (10 cases)

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

### 1.6 The summary report was looking at 1 of 14 checks

- **Symptom**: `gpt-oss-20b` had `jsonValid` 97.6% but the table showed compliance **100%**
- **Cause**: the summary column read only `hasAllRequired`, the easiest of the 14 implemented checks to pass.
  The first three models were all perfect, so it went unnoticed for three runs
- **Fix**: display **the lowest of the 14 checks plus that check's name** (`96.2% (altsExactlyTwo)`)
- **Side effect**: `gemini-3.5-flash-lite` was corrected from 100% → **99.5% (noHanjaLeak)**
- **Lesson**: when folding several metrics into one, **make the folding function visible in the
  name**. "Compliance" reads as all implemented checks but was actually 1, and while perfect scores keep
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

### 1.10 The fix for 1.9 recorded "unmeasured" as "zero"

- **Symptom**: 10 of 424 records in the `gemini-3.7-flash` run carry `reasoning_tokens: 0` with no
  error and a full hypothesis, while the other 414 have a minimum of 16 and a median of 315
- **Cause**: when the response carried no `total_tokens`, `total − prompt − completion` became a
  large negative and the `Math.max(0, …)` guard clamped it to 0. **The guard that stopped a
  nonsense number also erased the fact that there was no number**
- **Fix**: prefer the provider's explicit `completion_tokens_details.reasoning_tokens`; derive only
  when `total_tokens` is present; record `null` otherwise. `score.py` reports `reasoningTotal: None`
  when nothing was measured and marks the cost a lower bound when anything was not — the same
  None-not-zero rule already used for `streamFallbackRate` in 1.1
- **Result**: the published $3.0176 is a floor, understated ~4%. Every pre-field run's cost now
  carries `≥` in `bench/REPORT.md`, because the column had been mixing two definitions of "cost"

### Shared lessons

1. **A clean exit is not evidence of correctness.** Zero of the 10 cases above produced a crash
2. Where a failure is recorded determines the lifetime of the data. In a system with resume logic,
   **a wrongly recorded failure is permanent**
3. When folding metrics into one, make the folding visible in the name, and use the worst value
4. **A guard against a wrong value must not become a claim.** 1.10 is 1.9's fix producing 1.9's bug
   one level down: `0` for "not measured" is a statement about the model, and it is false

---

## 2. Disproved hypotheses

The point of measuring was not to confirm hypotheses but to kill wrong ones quickly.

### 2.1 "Translation quality is dominated by parameter count" — disproved

From 14B (local Q4) to 120B, **the COMET confidence intervals of all six models overlap**
(0.8849–0.8932, width 0.008, n=212). Model choice does not drive translation quality on this task.

Generation did separate them — `gemini-3.7-flash` at 0.8962 (0.890–0.902) is the first model to
break out of that overlapping band. **Not size, but generation.**

### 2.2 "Compliance is where fine-tuning will pay off" — disproved

Before any tuning the local 14B was already at **100% on all 14 implemented checks, 0 Hanja leaks out of 636**.
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

**Result** (212 items × 3 runs each, same `promptHash` and `datasetChecksums`):

| | thinking on | thinking off |
|---|---|---|
| latency p50 | 40,087 ms | **16,211 ms** |
| TTFB p50 | 25,144 ms | **534 ms** (47×) |
| COMET | 0.8849 (0.877–0.892) | 0.8861 (0.878–0.893) |
| compliance, lowest of 14 checks | 100% | 99.5% (1 item each on 2 checks) |
| judge `tipFactual` | 91.7% | 66.7% (n=12) |
| identical output across runs | 100.0% | 100.0% |

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
- **Cross-judge agreement has to be measured where the scores are low, not where they are high** —
  20 items were re-judged by a second judge (`openai/gpt-5.6-sol`) against the fixed
  `anthropic/claude-sonnet-5`. On the teacher's near-perfect output the two agreed 92.5%, which
  reads as "the judge is sound". On the student's output they agreed **66.2%**, and on
  `nuanceGrounded` — the primary tuning target — **50%**: 25% vs 75% on the same 20 items. The
  ceiling had hidden it. Had only the teacher been cross-judged, the conclusion would have been
  the opposite of the truth
- **That disagreement is a missing threshold, not a coin flip** — the two judges' notes say the same
  thing about the same items ("generic", "doesn't specify register or relationship", "다소 포괄적")
  and then split on whether that is a pass. `nuanceGrounded` never defines how specific is specific
  enough. Consequence: a fixed judge still measures a before/after delta honestly (one threshold,
  applied consistently, and sonnet is the stricter of the two), but **an absolute rate is not a
  property of the model**, and a target written as "≥ 83%" means nothing once the judge changes
- **Writing the threshold into the rubric did not fix it, and a $0.38 probe said so before $1.56 was
  spent** (2026-08-25). `nuanceGrounded` was rewritten around an operational swap test - *could this
  nuance be pasted onto an unrelated sentence without becoming wrong? then it fails* - and re-judged
  by both judges on the same 20 student items. Agreement moved 53% → 58%: both judges got stricter
  (sonnet 26% → 5%, sol 74% → 47%) without converging, leaving the same ~42-point gap. Editing the
  rubric changes `rubricHash`, which invalidates every cached verdict in the repository, so the full
  price of that change was 164 re-judged items ≈ $1.56. **Validate the fix on the smallest sample
  that can show the effect before paying for the whole thing.** The rubric was reverted, keeping all
  nine runs' cached verdicts valid
- **The right instrument for a tuning question is pairwise, not absolute** — the disagreement is
  about where "specific enough" sits on a continuum, and no wording pins that down across judges.
  But the question the tuning track actually asks is *"is the tuned output better than the baseline
  output on this item"*, which a judge can answer by comparing two outputs side by side without
  ever locating a threshold. Absolute rates stay for the cross-model table, where they are read as
  ranks; the before/after claim moves to a paired A/B judge

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
| Student at n=40 (2026-08-24) | Student judged on the idiom set. The gap is far wider than n=12 showed: `naturalFluent` 100% → **70%**, `nuanceGrounded` 41.7% → **30%**. On idioms the translation itself breaks, not only the explanation |
| Judge validation (2026-08-24) | Cross-judge on 20 items. Teacher 92.5% agreement, **student 66.2%**, `nuanceGrounded` 50%. The rubric has no pass threshold |
| Next | LoRA distillation — "as good as thinking, without thinking" |

---

## 7. Fine-tuning Phase 1–4 review (2026-08-26)

The Phase 4 dataset was independently regenerated from the stored batch response: 997 unique inputs,
996 accepted outputs, the same deterministic 896/100 split, zero train/valid overlap, matching file
hashes, and a matching `$1.649487375` cost. No pairwise result exists yet, so no invalid tuning win has
been published. The review did find blockers that must be closed before Phase 5 can produce a defensible
claim:

- ✅ *(closed, see 7.1)* pairwise comparability currently checks run IDs and dataset identity only; it
  must also reject a different prompt, scoring version, UI language, generation settings, JSON/streaming
  mode, or effective no-think transport
- ✅ *(closed, see 7.1)* item-level judge failures currently leave a partial file and still exit
  successfully; a 40-item success claim must require 40 complete, two-order verdicts
- ✅ *(closed, see 7.4)* the tuned MLX/Ollama path changes runner, quantisation and template as well as
  weights; evaluate against both the product baseline (`qwen3:14b`) and an untuned model on the same
  serving path before attributing a delta to LoRA
- ✅ *(closed, see 7.2)* the experimental runner needs `/no_think`, but that input transform is not yet
  recorded in `promptHash`; make it an explicit, persisted transport setting
- ✅ *(closed, see 7.2)* `ALL_CHECKS` contains 14 checks, not 15, and language tags are only checked for
  non-emptiness. Add a direction-aware language-tag check before restoring the 15-check label
- ✅ *(closed, see 7.3)* freeze the 20 manual-review IDs and record item-level decisions before looking at
  candidate results
- ✅ *(closed, see 7.1)* immediately before Gemini Batch submission, recompute the actual payload hash and
  compare it with the state file; the completed Phase 4 payload was checked after the fact and did match

Phase 3 proves that a fused affine int4 model loads and answers through Ollama. Peak memory (10.621 GB)
and the HTTP smoke result were terminal observations rather than durable machine-readable artifacts, so
they are operational evidence, not reproducible benchmark measurements.

---

### 7.1 The blockers that were code, fixed (2026-08-26)

A second `/code-review` pass over the two commits that introduced the pairwise judge and the teacher
batch (`f2c7942`, `dc13a44`) found that §7's rules were **documented but not enforced**: the code read
like it had complete guards, and did not. Seven were fixed; the remaining three in §7 are decisions and
experiment design, not code. Tests 57 → 61, all passing.

- **A p-value could be printed on a partial subset**
  - *Symptom*: `mainPairwise` summarised and exited 0 even with `failures > 0`. A failed item is simply
    absent from `subset.map(cached.get).filter(Boolean)`, so a run where 12 of 40 items hit a 429 prints
    `p=0.021` computed on n=28, with nothing on screen saying so
  - *Why it is dangerous*: it is the exact failure MEASUREMENT-NOTES §6 invariant 2 was written to forbid,
    and the surviving items are not a random subset — they are the ones the judge found easy to answer
  - *Fix*: after the loop, every item in the subset must have a complete two-order row or the command
    throws (exit 1). Partial rows stay on disk as resume points. The completion line now reads
    `complete/total` instead of `todo − failures`, which had also over-reported progress on resume
- **A network failure was laundered into "unparseable verdict"**
  - *Cause*: `judgePairwiseOrder` ended in `.catch(() => {})`. The catch is load-bearing — a judge verdict
    has no `alternatives`, so the translation parser rejects every valid verdict — but it swallowed 429,
    401 and dropped connections identically. A quota-exhausted run showed only `judge returned no JSON
    object:` with an empty body
  - *Fix*: empty `raw` means no response body ever arrived → re-throw. Non-empty `raw` means the response
    arrived and only the parser refused it → continue as before
- **Comparability checked two fields out of ten** — `validateComparableConfigs` now also rejects a
  differing `promptHash`, `scoringVersion`, `harness`, `uiLanguage`, `temperature`, `jsonMode`, `stream`
  or `reasoningEffort`. Git sha is deliberately excluded: a tuned run is always built later than its
  baseline, so requiring an equal sha would make every real comparison impossible
- **The judge's JSON extractor re-introduced the 1.5 bug** — `extractVerdict` / `extractPairwiseVerdict`
  used a greedy `/\{[\s\S]*\}/` without `stripThinking`, so a judge that emits a `<think>` block
  containing braces produced a slice from the scratchpad's first `{` to the answer's last `}`, `JSON.parse`
  threw, and the item was dropped. Same class as §1.5. Both now strip first; regression test added
- **The batch payload was never checked against the hash that attests to it** — `submitBatch` read
  `payload.json` from disk and POSTed it while `state.json` vouched for a different `inputHash`. The
  mismatch is undetectable after submission. It now recomputes the hash from what is actually about to be
  sent and refuses on mismatch
- **A certain rejection and a possible one shared a terminal state** — a 400/403, or a 200 with no
  `body.name`, landed in `submission_uncertain` exactly like a real timeout, and that state is terminal:
  `submit` refuses (`status !== 'prepared'`), `status` refuses (no `jobName`), `prepare` returns
  unchanged. Recovery meant hand-editing `state.json`. A 4xx with a parsed error body is now a *certain*
  rejection — the server created nothing — so the batch returns to `prepared`; only no-response, 5xx, or
  an unreadable 2xx stays uncertain
- **The train/eval leakage test could pass without testing FLORES** — the eval side was
  `[...].filter(existsSync)`, and `flores.jsonl` is gitignored (regenerable, not committed). With it
  absent the FLORES half of the comparison silently dropped out while `assert.ok(evalFiles.length)` still
  passed on the handbuilt files. All three eval files are now required. The `t.skip` when
  `train/raw.jsonl` is absent is kept on purpose: before tuning there is nothing to leak
- **`sampleFloresTrain.js` regenerated the training set on import** — `main()` ran unconditionally, unlike
  `judge.js` and `teacherBatch.js` which have a `process.argv[1]` entry guard. Guard added

Deliberately not changed: `judgePairwiseOrder` still uses `_translate` with no retry. Two fixed
observations is the right semantics for a paired comparison — retrying until a judge agrees is not a
measurement — and the completeness gate above is what makes it safe, because a lost item now stops the
run instead of shrinking n.

---

### 7.2 Three more blockers closed (2026-08-26)

The remaining §7 items were worked in parallel; one is design, not code, and is only half done.

**A `/no_think` run and a thinking run had the same prompt hash.** The Ollama experimental runner
ignores `reasoning_effort` and obeys only Qwen3's native `/no_think` tag in the message, so the
tuning track's serving path had no recorded, hashed way to say which mode a run used —
`promptHash` covered `buildSystemPrompt()` and nothing else. Two runs that differed in whether the
model thought at all were therefore byte-identical in every comparability field, and §7.1's brand-new
`validateComparableConfigs` would have waved them through as equivalent. Fixed with a config field,
`promptSuffix`, appended to the user message and folded into `promptHash`. It is hashed
unconditionally rather than only when set, because `hash.update('')` is a no-op: the baseline's
recorded `3d18dda71bc9…` is unchanged, which `src/run.test.js` now asserts against the literal —
a change there silently invalidates every row of `bench/REPORT.md` at once. The tag goes in the user
message, not the system prompt, because the standard Ollama runner is documented to ignore it there.

**`hasAllRequired` passed a model that got the direction exactly backwards.** The two language tags
were checked only for being non-empty strings, so `detected_lang: "EN", target_lang: "KO"` on a
`ko_to_en` item scored a clean pass on all 14 checks. Added `langTagsMatchDirection` (case- and
whitespace-insensitive, and vacuously true for an item with no forced direction, of which the dataset
has none). `ALL_CHECKS` is now genuinely 15, `scoringVersion` is 2, and the "15-rule compliance"
label is finally accurate.

- **What it found**: one item, `flores-ke-0007`, fails on the product baseline
  (`qwen3-14b-local-nothink`) in **all three runs** with the tags exactly reversed. Reproducible, not
  a sampling artefact, and invisible to every other check — including COMET, which scores `natural`
  and never looks at the tags. Rate 99.53% (3/636). `gpt-oss-20b`'s five failures are all records
  that already had no parsed response, so they were already outside the compliance pool and the check
  adds nothing there. Every other run is 100%
- **No published number moved.** The new check does not become anyone's worst rule — the no-think
  baseline's floor stays 99.53% (`altsSizesValid`, coincidentally the same rate), so the
  `≥ 99.53%` regression threshold in the tuning plan survives the count going from 14 to 15, and
  `bench/REPORT.md` regenerated byte-identical
- **Historical runs**: `npm run rescore` recomputes a finished run's compliance block from its stored
  raw output — no API calls, and it touches nothing but `compliance`. Verified before writing that
  the only key differing across all 3,505 records was the new one. Separately, `compliance_rates()`
  in `score.py` now uses a per-key denominator: a check added after a run was recorded is *absent*
  from those rows, and counting absent as False would have published a new check as "0% for every
  historical model" — a measurement that never happened, reported as total failure
- **The teacher data is unaffected**: all 996 accepted Phase 4 outputs pass the new check, so the
  896/100 split does not need rebuilding

**The manual 20 is frozen; its verdicts are not.** `bench/datasets/v1/manual-regression-20.json`
commits the id list, the selection rule that produced it, the dataset checksum it was frozen against,
and the no-think baseline's full output for each of the 20 — with `verdict: null` for a human to
fill. Freezing the ids alone would not have been a freeze: they point at dataset items, so an edit to
`handbuilt-ext.jsonl` could change what the gate means without touching the frozen file, which is why
`src/manualRegression.test.js` asserts the checksum, the selection, the 5-per-stratum balance, and
that every row has a baseline output to review. The selection is `selectPairwiseSubset(…, 20)` —
stratified 5 per slice × direction, lowest id first within each stratum, so it is balanced and
deterministic but not random; for a failure gate that is acceptable and it is now written down.
**The item-level verdicts must be recorded before any tuned candidate output exists**, or the gate
is a post-hoc rationalisation rather than a control.

**One regression caught in the same pass**: scoring the two smoke runs (3 and 30 items) to test the
rescore path added them to `bench/REPORT.md` as peer model rows and changed the headline to
"Benchmarked 9 model(s)". `generate_summary_report.py` now skips `smoke*` run directories by name —
the config carries no field that distinguishes a pipeline check from a measurement.

Tests 61 → 67.

---

### 7.3 The manual gate, reviewed (2026-08-27)

All 20 verdicts recorded while Phase 5 has not run, so no tuned output exists that could have shaped
them. **Baseline result: 12 pass, 8 fail** — 7 meaning distortions and 1 Hanja leak.

| id | why it fails |
|---|---|
| `hbx-idc-014` | `걔는 귀가 얇아` → "She has thin ears." The idiom means *easily swayed*; it was rendered as ear thickness, and `nuance`/`tip` then recommend "delicate" or "small" as better ear adjectives. The model never noticed there was an idiom |
| `hbx-idc-013` | `손이 미끄러졌어` → "I slipped." The subject moved from the hand to the speaker: dropping something became falling over. All five alternatives repeat it |
| `hbx-idc-003` | "Break a leg!" → `잘 가라!` — a goodbye, not encouragement. `nuance` explains the idiom correctly and an alternative even carries `행운을 빌어`, so the one field the user reads is the only one that is wrong |
| `hbx-idc-002` | "You can say that again." → `그 말 다시 해줘도 괜찮아` — permission to repeat, where the idiom is emphatic agreement. `nuance` repeats the misreading |
| `hbx-idc-001` | "butterflies in my stomach" → `마음이 허물어지는 것 같아요` — a heart *collapsing*, not fluttering. `literal` and `nuance` are both right; `natural` is not |
| `hbx-idc-005` | Hanja leak inside `natural`: `그 이름은 좀耳에 익은 것 같아`. Meaning correct, alternatives clean. The same item `hanjaLeak` already flags at run time |
| `hbx-idb-014` | `양해 부탁드립니다` → casual alternatives "Get it?" / "You know what I mean?", which ask whether the listener understood rather than asking them to bear with the speaker |
| `hbx-idb-012` | `잘 부탁드립니다` → casual alternatives "You've got this." / "You're on it.", encouragement where the source is a request |

Two things this exposes that no automated check in the harness sees:

- **The failure is concentrated in `natural`, and the other fields often know better.** On three of the
  five idiom-casual failures the `nuance` or `literal` field states the idiom's real meaning while
  `natural` renders it literally. That is not a knowledge gap, it is a field-level breakdown — and it is
  encouraging for distillation, because the information is already in the model
- **`alternatives` is where the business-register failures live.** Both `idiom-business` failures have a
  correct `natural` and a wrong casual alternative. Compliance counts alternatives (`altsExactlyTwo`,
  `altsSizesValid`, `altsRegistersValid`) and never reads them; the LLM judge's `altsDistinct` asks
  whether they differ from each other, not whether they mean what the source means. This gate is the
  only instrument in the project that looks

**12/20 = 60% is consistent with the judge's 70% `naturalFluent` on the full 40** — same order, slightly
stricter, which is what a hand review of a smaller sample should look like. Two independent instruments
landing in the same place is weak evidence that neither is wildly miscalibrated.

**Scope, written down before it can be tuned to**: the gate reads `natural`, `literal`, and the
alternatives' expressions. A weak `nuance` or `tip` is not a failure here — those have their own judge
criteria — but a `nuance` that repeats an error in `natural` is cited as evidence the error is
systematic. The tuned candidate gets judged under exactly this scope, and fails if it distorts meaning
or leaks Hanja on any item the baseline passed. Fixing a baseline failure is **not** evidence of
success; that is the pairwise sign test's job.

**Provenance caveat, recorded in the file itself.** This gate exists as the check that is *not* an LLM
judge, and it was filled in by an LLM (Claude, at the owner's instruction) — the same vendor as the
`claude-sonnet-5` absolute and pairwise judge, so the verdicts are not independent of it and plausibly
share its blind spots. They are best read as a **pre-registered written standard** rather than as a human
control. A person should re-read at least the eight failures before any tuning claim leans on this file.
`src/manualRegression.test.js` now fails if a verdict returns to `null`, if a verdict disagrees with its
own two reasons, or if a failure carries no written reason.

---

### 7.4 The untuned control, and what it immediately proved (2026-08-27)

The last §7 blocker. The control is the base model taken through the *entire* tuning pipeline with
the weights left alone: MLX initialises `lora_b` to zeros and `LoRALinear.fuse()` computes
`weight + (scale · lora_bᵀ) @ lora_aᵀ`, so fusing an untrained adapter is `weight + 0`. Built by
`bench/tuning/make_zero_adapter.py`, fused, imported as `haen-qwen3-14b-untuned-control`, and
measured on the 40 idiom items as `qwen3-14b-untuned-control-ext`.

**It earned its cost on the first run: 31 of 40 `natural` outputs differ from the product baseline,
with mathematically identical weights.** Serving path alone — MLX int4 affine through Ollama's
experimental Safetensors runner, versus Q4_K_M through the standard one — rewrites 78% of this set.
Several of those changes look like improvements:

| item | product baseline | untuned control |
|---|---|---|
| `hbx-idc-005` | `그 이름은 좀耳에 익은 것 같아.` (Hanja leak) | `그 이름이 어렴풋이 기억난다.` |
| `hbx-idc-003` | `잘 가라!` (a goodbye) | `잘 해봐!` |
| `hbx-idc-013` | "Oh no, I slipped." | "What a shame, I slipped." (still the wrong subject) |
| `hbx-idc-014` | "She has thin ears." | "She's got thin ears." (still literal) |

Compliance moves too: the control is **100% on all 15 checks**, where the baseline's one Hanja leak
put it at 97.5%. Without this control, a tuned model showing no Hanja leak would have had that
credited to LoRA. Latency p50 is also lower (9,089 ms vs 10,931 ms), which is a quantisation and
runner difference, not a tuning result. **This is the whole argument for the control in one run.**

**A compliance check broke on the new transport, and it broke silently.** The control scored
`prosePreamble` 0/40. Not prose: `/no_think` makes Qwen3 emit an empty `<think></think>` before the
answer, so the body no longer starts with `{`. The client strips that block before parsing and the
user never sees it, so this measured the serving path and called it an instruction-following failure
— and because the summary column reports the *worst* rule, it would have published the tuned
candidate and its control at 0% compliance.

- **Fix**: `fenced` and `prosePreamble` now read the thinking-stripped body. `empty` deliberately
  still reads the raw text — it asks whether a response arrived (transport), not whether the model
  formatted its answer (instruction-following)
- **Checked before changing anything**: `qwen3.6-27b`'s 97 flagged items are *real* prose ("Here's a
  thinking process:" with no tags at all), so its published 54.2% `noPreamble` is genuine and
  unmoved. Across all 3,545 records the fix changes exactly the 40 control rows, and `bench/REPORT.md`
  regenerated with one line different: the count of runs sitting outside the model matrix

**`scoringVersion` meant two things at once.** Bumping it to 3 made the new control incomparable to
every earlier run — the field is stamped at run time, and `validateComparableConfigs` compares it, so
a rescored old run stayed "not comparable" forever despite its compliance having been re-derived by
the current code. It now means *the version that computed the stored compliance*: `npm run rescore`
stamps it after re-deriving, and judge verdicts keep their own `rubricHash`. `SCORING_VERSION` lives
in `compliance.js` with a changelog, `run.js` imports it instead of repeating a literal, and
`test_score.py` fails if the Python copy drifts from the JavaScript one.

**One thing this closes is also one thing it opens — and it is now decided.** The gate rejects
control-vs-product-baseline: `promptHash` and `reasoningEffort` both differ, correctly, because they
*are* different transports. That invalidates the shape of the plan's first comparison — tuned vs
`qwen3:14b` is not a controlled A/B, so a sign test on it would report a p-value that folds the
serving stack into the model. The control had already put a number on how large that confound is:
31 of 40 outputs differ with identical weights.

**Decision (2026-08-27): significance is claimed only for tuned vs untuned control.** The product
comparison is reported as descriptive statistics — win/loss/tie counts and the absolute table, no
p-value computed and none quoted — and labelled as what it is, a comparison between two products
whose serving paths differ. The gate's rejection is not to be worked around; refusing to compute the
statistic is the decision, not an obstacle to it. `FINETUNING.md` §2 and §6 now carry this, including
a check that pairwise's `--baseline-run-dir` points at the control.

**The absolute judge on the control ($0.38, 40 items, `claude-sonnet-5` fixed) made the confound
worse than the output diff suggested.**

| criterion | product baseline | untuned control | items flipped (of 40) |
|---|---|---|---|
| `naturalFluent` | 70.0% | 72.5% | 9 (5 up, 4 down) |
| `nuanceGrounded` | 30.0% | 27.5% | 13 |
| `altsDistinct` | 52.5% | 47.5% | 16 |
| `tipFactual` | 70.0% | **50.0%** | **20** |

Two things follow, and both change the plan.

**The net rate hides the churn.** `naturalFluent` moved 2.5 points, which reads as "basically the
same model" — and it is the same model — while nine individual items changed verdict. A tuned
candidate reporting a few points of net gain on an absolute criterion would be indistinguishable from
this. It is the reason the primary success criterion is an item-paired sign test rather than a
difference of rates, and that choice now has a number behind it instead of an argument.

**The regression thresholds were anchored to the wrong model.** `FINETUNING.md` §2 froze
`altsDistinct ≥ 52.5%` and `tipFactual ≥ 70.0%` from the product baseline. The control already sits
at 47.5% and 50.0% — so a tuned model that changed nothing would fail two regression gates for a
serving difference that predates it. Thresholds re-anchored to the control, with the baseline values
kept in parentheses. Two items are left open rather than guessed: COMET's CI floor is a 212-item
number and the control was only run on the 40 idiom items, and the frozen manual-20 verdicts were
recorded against baseline outputs that differ from the control's on 31 of 40 items.

Tests 68 → 69.

### 7.5 Two library defaults that would each have wasted the run (2026-08-27)

Phase 5's first QLoRA run was configured from the plan's starting hyperparameters, started,
and stopped ten minutes in. Two `mlx_lm` defaults do not mean what the plan assumed.

**`iters` counts micro-batches, not optimizer steps.** The training loop is
`zip(range(1, iters+1), iterate_batches(batch_size=...))`, so at `batch_size: 1` one iter is
one training record. The planned `iters: 500` is therefore 0.56 of an epoch over the
896-record split and 62 Adam updates, not 500. A rank-8 adapter pushed 62 times at 2e-5 does
not move, and a run that changes nothing is not a negative result — it is an uninformative
null that costs six hours and answers nothing. The tell was in the first report line:
`Trained Tokens 3095` after 10 iters is ~310 response tokens per record, which only divides
out if an iter is one record. Corrected to 1,792 (2 epochs, 224 updates).

**`mask_prompt` defaults to false.** The system prompt is ~1,365 tokens of a ~1,170-token
median record, so the default spends most of the loss teaching the model to predict a fixed
string it is handed at inference anyway. Set to true: this track corrects behaviour, so only
the teacher's response should carry gradient.

Neither default is wrong — they are right for the common case of short prompts and step-wise
budgets. Both are wrong for this shape of data. The lesson is narrower than "read the docs":
**a hyperparameter copied from a plan is not verified until one report line has been
divided out by hand.** Ten minutes of arithmetic against the first log line caught both.

A third finding came from trying to make validation cheaper. Full-holdout validation costs
667s, and `val_batches: 25` looks like the obvious trade. It is not available: `iterate_batches`
draws validation batches through `np.random.permutation`, so a reduced count scores a
different random subset each time and the losses cannot be compared across evals — which is
the only thing the holdout is for. Kept the full set and took fewer points instead. A coarse
curve is readable; a noisy one is not.

Tests 69 → 70.

### 7.6 The first tuning run finished, and the loss curve cannot say whether it worked (2026-08-27)

Phase 5's first QLoRA run completed in 6h08m on the corrected configuration: 1,792
micro-batches (2 epochs, 224 Adam updates), rank 8 over the top 8 layers, LR 2e-5,
`mask_prompt` on, peak memory 15.617 GB of 24 GB. Holdout loss over the full 100-item
validation split went 1.566 → 0.943 → 0.900 → 0.881 → 0.867 → 0.869 → 0.864 → 0.860 → 0.859.

Two numbers are worth keeping. **94% of the improvement landed in the first 28 optimizer
updates** (−0.623 of −0.707), and **the entire second epoch bought 0.008** against the
first epoch's 0.867. The second is a measurement, not an estimate: the next run can be
one epoch and finish in half the time.

The first number is the one to be careful with. A loss curve that drops hard and then
flattens is the expected shape when a model is learning an output *format* — this
teacher's records are a 1,365-token system prompt and a six-field JSON response, and the
cheap thing to learn is the schema. Whether the thing this track actually cares about
changed — literal renderings in the `natural` field on idioms — is not something this
curve can distinguish from schema fitting. Both look like loss going down.

So the run's outcome is not declared here. It is declared by the judge, against the
untuned control, on the item-paired sign test. The loss curve says training was healthy:
monotone, non-divergent, one +0.002 blip at iter 1120 that recovered, train-val gap
widening from 0.03 to 0.12 while validation still fell — decelerating returns, not
overfitting. "Healthy" and "worked" are different claims and only the first is supported.

Keeping the full holdout instead of sampling it (rejected in 7.5, because
`iterate_batches` permutes validation batches too) is what makes this readable at all.
The differences that carried the decisions here are 0.008 and 0.002; a different random
25 items per evaluation would have buried both in noise.

### 7.7 The fuse destroyed what the training learned (2026-08-27)

The tuned candidate was fused, imported, and measured on the 40-item idiom set. It failed a
hard regression gate immediately: `altsExactlyTwo` fell from 100% to **22.5%** — 9 of 40
outputs carried the required two alternative categories, 25 carried one, and 6 carried none.
Latency p50 halved, 9,153 ms to 5,017 ms, which looked like a win and was a symptom: fewer
alternatives is less text.

Every cheap explanation was eliminated before an expensive one was entertained, and all of
these cost nothing:

| Checked | Result | Ruled out |
|---|---|---|
| teacher data's alternative counts | **996 of 996 have exactly two** | bad training data |
| training log truncation warnings | none | `max_seq_length` clipping targets |
| generation with and without `/no_think` | one alternative either way | train/inference prompt mismatch |
| `mask_prompt` offset logic | masks exactly up to the assistant turn | the one non-default setting |
| **MLX with the adapter**, checkpoints 224 / 896 / 1792 | **two alternatives, all three** | **the training itself** |
| **MLX with the fused checkpoint** | **[1, 2, 1]** | Ollama, and the chat template |

The adapter applied at inference obeys the rule. The same weights fused into the checkpoint
do not, and they fail the same way inside MLX as inside Ollama — so the defect is the fuse,
not the importer and not the serving template.

**The mechanism was already measured, two steps earlier, and not recognised.** `fuse()`
dequantises the int4 weight, adds the LoRA delta, and re-quantises. Verifying the fused
candidate gave a mean absolute weight delta of **2.81e-4** against the untuned control. The
control's own measured re-quantisation noise against the base checkpoint is **2.6e-4**. The
signal is the size of the rounding error, so re-quantising does not carry the learned delta
through — it rounds most of it away and adds a perturbation of its own at the same scale.
What comes out is neither the base model nor the tuned one.

That number was recorded when the candidate was fused, described as "thin", and correctly
flagged as a weak predictor of behaviour — weight-space distance usually is. The error was
treating it as a fact about how much the tuning would *matter* rather than as a fact about
whether the tuning would *survive the pipeline*. Those are different questions and only the
second one is answerable from weight magnitudes.

**This also breaks the untuned control's premise, which is the more expensive lesson.** The
control was built so the fuse round trip's perturbation would appear on both sides and cancel.
That argument holds only if the perturbation is additive and independent of the delta. Here it
is neither: it is the same size as the delta and it acts *on* the delta. The control still
cancels the noise, but after fusing there is no signal left for it to be compared against.

A control proves that two arms took the same path. It cannot prove the path preserved the
thing being measured. Nothing in this project's design would have caught this — the invariant
that went unstated is that **the serving pipeline must have a resolution finer than the effect
being served**, and it was never checked because it had never been articulated.

Nothing was spent. The paid judge was queued behind this measurement and did not run: judging
here would have scored a model the fuse had already corrupted, and reported it as the result
of fine-tuning.

### 7.8 A flag that was accepted and ignored, caught by two arms that agreed too well (2026-08-28)

With fusing ruled out (§7.7), both arms were re-run through `mlx_lm.server`, the control as
the base model and the candidate as the base plus `--adapter-path`. A shell script started
each server, asserted the live command line carried the adapter the config named, and ran the
benchmark. Both arms completed cleanly, 40 items each, no failures.

Then the comparison: `natural` differed on 0 of 40 items. So did `literal`, `nuance`, and
`tip`. **The two arms were byte-identical in every scored field.**

A LoRA adapter that changes nothing is a possible result. It was not this one — loading the
same adapter through `mlx_lm.load(adapter_path=...)` and generating produced visibly different
output from the base on the same prompt. So the adapter works and the server was not applying
it.

The cause is two lines of `mlx_lm/server.py` (0.31.3, the newest release):

```python
self._adapter_map["default_model"] = self.cli_args.adapter_path   # 316
...
model_path   = self._model_map.get(model_path, model_path)        # 388  "default_model" -> real path
adapter_path = self._adapter_map.get(model_path, adapter_path)    # 389  looks up the REAL path
```

The adapter is registered under the literal key `"default_model"`, but the lookup happens
*after* that name has been resolved to the model path, so it never hits. Requesting the model
by id misses; requesting `"default_model"` also misses, because by line 389 the name has
already been rewritten. Verified both ways: both return base-model output.

**The guard that should have caught this checked intent, not effect.** It confirmed the
process was started with `--adapter-path tuning/adapters-run1` — which was completely true and
completely irrelevant, because the flag was accepted and discarded. This is the identical
failure shape to Ollama importing a quantised checkpoint as 1.8B bfloat16 without erroring
(`bench/tuning/README.md`), and to `mlx_lm`'s `iters` counting something other than what the
plan assumed (§7.5). Three times now in this track, an option has been accepted and silently
not honoured.

The fix that generalises is not "read more source". It is that **a serving arm has to prove
itself by behaviour before it is allowed to produce numbers.** `bench/tuning/mlx_server_adapter.py`
now registers the adapter under the resolved path too, and `--verify-adapter` generates once
with and once without the adapter and refuses to start the server unless the outputs differ.
`run_mlx_arms.sh` requires that verification line in the log before it will run the benchmark.

What made this catchable was cheap and worth stating on its own: **two arms that agree exactly
are evidence of a broken harness, not a null result.** Real models given different weights do
not produce byte-identical text on 40 items. The comparison that was supposed to measure the
tuning measured the plumbing instead, and said so loudly enough to notice.

**A correction to §7.7.** That entry cited `nuance` appearing in Korean rather than English as
a sign the adapter was taking effect. That was inferred from a single probe. Counting all four
runs, every one is 20 Korean / 20 English — the field's language tracks translation direction,
not tuning. The observation was wrong and is withdrawn; §7.7's conclusion is unaffected, since
it rests on `altsExactlyTwo` collapsing to 22.5% under fusing while every checkpoint served
with the adapter holds at 100%.

### 7.9 The first honest tuned-vs-control numbers, and why there is still no verdict (2026-08-28)

With both arms served through the verified path (§7.8), the candidate and the untuned control
differ where they should: `natural` on 30 of 40 items, `literal` on 12, `nuance` and `tip` on
all 40. Both ran 40 items with zero failures.

Absolute judge, fixed `anthropic/claude-sonnet-5`, identical serving conditions, n=40:

| criterion | control | tuned | delta | flipped | tuned better | control better |
|---|---|---|---|---|---|---|
| `naturalFluent` | 75.0% | 70.0% | −5.0pp | 10 | 4 | 6 |
| `nuanceGrounded` | 27.5% | 30.0% | +2.5pp | 11 | 6 | 5 |
| `altsDistinct` | 50.0% | 55.0% | +5.0pp | 10 | 6 | 4 |
| `tipFactual` | 62.5% | 50.0% | −12.5pp | 15 | 5 | 10 |

**The two criteria this track exists to improve — `natural` and `nuance` — did not improve.**
`naturalFluent` fell 5pp and `nuanceGrounded` rose 2.5pp, one item either side of noise on a
40-item sample. `tipFactual` fell 12.5pp, the largest single move and the wrong direction.

The flip counts matter more than the rates, for the reason recorded in §7.4: 10 to 15 items
change verdict under every criterion, so a 1-item net delta is a net of five or six changes in
each direction, not five or six items quietly improving.

**Compliance regressed by exactly one item.** `altsExactlyTwo` 100% → 97.5%. The cause is a
structural JSON defect in `hbx-idc-001`: the model closed the root object after the first
alternative (`...]}]}`) and then continued with a second one, so the parser salvaged the
scalar fields and recovered no alternatives. One malformed object in 40 is a different
animal from fusing's 78% collapse, but the regression threshold is "worst check ≥ 100%", and
97.5% does not meet it.

**The primary criterion did not complete.** The item-paired pairwise sign test needs both A/B
orders on all 40 items; OpenRouter credits ran out at 17 complete, and the completeness gate
added in §7.1 refused to print a p-value on the partial subset — correctly, and the partial
counts are not reported here either, since the 17 that finished are the first by dataset
order rather than a random sample. Resuming needs about $0.44 of credit; the judge caches, so
a re-run continues rather than restarts.

**What can be said, and what cannot.** The tuning ran, the adapter demonstrably changes the
model's output, and on 40 items judged absolutely it did not improve the two target criteria.
That is a real negative signal but not the verdict: the sign test is the primary criterion
precisely because absolute rates hide item-level churn, and it has not run. No success is
claimed. No failure is declared either, and the difference is not a hedge — declaring failure
on the criterion that was explicitly designated secondary, because the primary one was
unaffordable, would be the same substitution the sign test exists to prevent.

### 7.10 The verdict: the first tuning run did not work (2026-08-28)

The pairwise sign test completed — 40 of 40 items, both A/B orders, zero failures, fixed
`anthropic/claude-sonnet-5`, both arms served through the verified unfused path (§7.8).

| criterion | candidate wins | control wins | ties | exact sign test |
|---|---|---|---|---|
| `natural` | 5 | 12 | 23 | p = 0.143 |
| `nuance` | 5 | 14 | 21 | p = 0.064 |

The success criterion, fixed before training began, was candidate wins > control wins on
**both** `natural` and `nuance` with p < 0.05. The candidate loses both, roughly 1 to 2.5.
**This run failed, and the direction is the wrong one.**

What can be claimed precisely: there is no evidence the tuning helped, and the point estimate
on both criteria favours the untuned model. Neither result clears p < 0.05, so "significantly
worse" is not established either — `nuance` at p = 0.064 is suggestive of harm and nothing
more. The honest summary is a failed run with a consistently negative direction, corroborated
by the absolute judge in §7.9 (`naturalFluent` −5.0pp, `tipFactual` −12.5pp) and by compliance
(`altsExactlyTwo` 100% → 97.5%). Four independent measurements, none of them positive.

**More than half of the items are ties** — 23 on `natural`, 21 on `nuance` — but they are not
the same kind of tie, and an early reading of this entry conflated them. Cross-referencing the
absolute verdicts: of the 23 `natural` ties only **2** are items both models failed; the other
21 are items both models passed. Of the 21 `nuance` ties, **11** are shared failures. So the
judge's notes about both models breaking the same idioms — `발이 넓다` as literal foot size,
`입이 무겁다` as "quiet" rather than "discreet", `철들다` as "get a grip", `눈치` as "watch for
danger" — describe the `nuance` ties, not the `natural` ones. On `natural` the two models are
mostly tied because both are already adequate.

**The teacher solves almost all of the shared failures**, which is the number that decides what
to do next. `gemini-3.7-flash` passes 2 of 2 shared `natural` failures and 10 of 11 shared
`nuance` failures. Measured as a ceiling over the full 40 items against this control:

| criterion | control | teacher | items the teacher wins / loses |
|---|---|---|---|
| `naturalFluent` | 75.0% | 100.0% | +10 / −0 |
| `nuanceGrounded` | 27.5% | 95.0% | **+27 / −0** |
| `altsDistinct` | 50.0% | 82.5% | +14 / −1 |
| `tipFactual` | 62.5% | 97.5% | +15 / −1 |

Distillation is not out of room — it has 27 items of headroom on the primary target and has
captured none of them. The teacher has the answers and the training set never asked the
questions.

That is the diagnosis this run was worth its six hours to produce, and it was predicted:
the 896 training sentences are FLORES wiki and news prose containing **zero idioms**, while
success is judged on 40 idiom items. The distribution mismatch was recorded before training as
a risk; the tie counts are now its measurement. The model learned the teacher's output *format*
— which is what the front-loaded loss curve showed (§7.6, 94% of the drop in 28 updates) — and
learned nothing about idioms, because there was nothing about idioms to learn.

**The by-slice split points the same way.** On `idiom-business` the candidate wins 1 of 20 on
`natural` against the control's 5, with 14 ties; on `idiom-casual` it wins 4 against 7, with 9
ties. Business idioms are almost entirely ties — formulaic phrases where both models produce
the same serviceable output and tuning had no room to change anything.

**What this rules out, which is the useful part.** It is not "fine-tuning does not work here".
It is that fine-tuning on data with none of the target phenomenon does not work here, which is
a much narrower and more actionable claim. The next run has a specific instruction rather than
a hunch: build idiom training data (`FINETUNING.md` 4.2.1 gives the procedure, including the
eval-overlap removal that a hand-written set needs), and re-measure against this same control.
Raising rank or learning rate first would be pushing harder on data that does not contain the
answer.

Total measured cost of reaching a defensible negative: ~$11.5 across the whole project, of
which this run's judging was ~$1.5. The result is worth more than a claimed win would have
been, because it is the one a reader can check.

### 7.11 Peak memory was measured; swap was not (2026-08-31)

Run 1 recorded MLX's peak resident memory at every report interval — 14.609 GB rising to
15.617 GB of 24 GB — and that number was quoted as evidence the run fit comfortably. It is
evidence of one thing only: how much memory the process held. It says nothing about what the
operating system did to keep it there. A run can sit at a comfortable-looking peak while the
machine pays for it in swap, which costs SSD write endurance and wall-clock time and appears
in no field the training log contains.

Swap was never sampled during run 1, and the question turned out to be unanswerable after the
fact: `vm_stat`'s swap counters are cumulative since boot, and the machine had rebooted on
2026-08-29, two days after the run. The counters that would have held the answer were gone.
This is a different failure from the ones in §7.8 and §10 — nothing was asserted falsely. The
measurement simply was not taken, and the window to take it had closed.

Reproduced instead on the same configuration and hardware: the same config at 100 iterations,
sampled every 15 seconds for 33 samples. Swap in use moved 420.44 → 428.44 MB against a
1,024 MB swap file, **new swapouts were zero**, and free memory bottomed at 23% against 79%
idle. Run 1's own log shows peak memory reaching 15.029 GB by iteration 80 and settling at
15.617 GB, so the memory ceiling is inside the reproduced window; a longer run does not visit
a state this one missed. The configuration does not swap on a 24 GB machine.

That is an argument, not a record — it establishes what this config does on this hardware, not
what happened during run 1. The fix is that the answer stops depending on someone remembering
to ask. `bench/tuning/memwatch.sh` samples swap, memory pressure, and swapout deltas to a log;
`bench/tuning/train.sh` starts it alongside any training config, writes both logs under
matching timestamps, and prints a one-line summary at the end — including an explicit warning
line if the run caused any swapouts.

The general shape is worth separating from the specific metric. **A measurement that is only
available while a job runs has to be taken during the job or not at all**, and the ones most
likely to be skipped are exactly those the process cannot see about itself. Peak memory is
self-reported and therefore always in the log. Swap is the operating system's view of the same
event, and nothing in the training loop was ever going to record it.

### 7.12 A ten-hour job that a closed lid could kill (2026-08-31)

Run 2 was configured for one epoch — 1,345 iterations, estimated three hours from run 1's
measured rate. It stopped at iteration 880 with no error, no traceback, and no summary line:
the wrapper process itself was gone, so nothing inside the training loop had failed.

The memory log written by `train.sh` (§7.11) is what made the cause legible, and it is the
first time that instrumentation paid for itself:

| when | swapouts since start | note |
|---|---|---|
| 07:26 | 2,460 | model load, ~39 MB, matches the swap-usage step exactly |
| 07:48 | 9,476 | |
| 07:48 → 16:49 | **flat for nine hours** | training itself caused no swapping |
| 16:49 | 41,496 | swap file grew 1,024 → 2,048 MB |

Two things fall out of the timestamps. The sampler is on a 30-second interval and recorded 519
samples across 10.6 hours, where 1,270 were due; individual gaps stretch to 13.7 minutes. A
sampler that sleeps 30 seconds and wakes 13 minutes later was not descheduled by memory
pressure — the machine was asleep. And accounting for the work actually done (880 iterations
at the logged 0.085 it/s, plus four evaluations totalling 1.4 hours) gives 4.3 hours of
compute inside a 10.6-hour window. **Six hours are missing, and no reboot occurred.**

The job died in that state, most plausibly during a sleep or wake transition. What matters is
that a multi-hour local job had no protection against it, and that the failure was silent:
without the memory log there would have been an interrupted run, no error, and no way to
distinguish "the machine slept" from "training crashed" — two problems with opposite fixes.

The fix is `caffeinate -ims` around the training call in `train.sh`, not a retry loop. A job
that a closed lid can end is not a job.

**A correction to §7.11.** That entry concluded "this configuration does not swap on a 24 GB
machine", from 33 samples over eight minutes on run 1's config. Run 2 — 1,345 training records
and a 150-record holdout instead of 896 and 100 — swapped 41,496 pages and doubled the swap
file. The narrower statement the evidence supported was always "run 1's config, at this moment,
on an otherwise idle machine". Sampling per-run is what turned that from an argument into a
record, and the first run it recorded contradicted the generalisation. That is the instrument
working, not failing.

Resumed from the iteration-672 checkpoint rather than restarting: `mlx_lm` saves no optimizer
state, so Adam's moments reset, but the learning rate is a constant with no schedule and what
is lost is roughly ten steps of momentum out of 168 updates. The resume config uses a new seed
(the batch permutation is seeded, so the same seed would replay the records already seen) and
a new adapter directory (numbered checkpoints restart at 224 on resume and would overwrite the
first attempt's, destroying the only record of what it reached).

### 7.13 The second run finished, and the automatic metrics cannot tell it from the control (2026-09-02)

Run 2 completed its epoch across three legs — 672 + 224 + 449 of 1,345 iterations, two
deliberate resumes and one machine-sleep death between them. Holdout loss fell 0.908 → 0.885
over the final leg. The adapter is `tuning/adapters-run2c`.

Both arms were then served unfused through `mlx_server_adapter.py`. The behavioural gate
passed — *adapter verified: output differs from the base model* — and the candidate's outputs
differ from the control's on 30 of 40 `natural` fields, 40 of 40 `nuance`, and 36 of 40
`literal`. The adapter is unambiguously doing something.

What it is doing does not show up in any automatic metric:

| | control | run 1 | run 2 |
|---|---|---|---|
| COMET overall | 0.7064 | 0.6902 | **0.7069** |
| COMET 95% CI | 0.6621–0.7494 | 0.6445–0.7361 | 0.6549–0.7568 |
| chrF2 | 24.583 | 24.634 | **25.177** |
| latency p50 (ms) | 9,767 | 9,572 | 9,763 |
| `altsExactlyTwo` | 1.000 | 0.975 | 0.975 |

COMET moves by 0.0005 on n=40, against a confidence interval 0.09 wide. That is not a small
effect, it is no effect the instrument can see. Run 2 also **fails the compliance gate** for
the same reason run 1 did: `altsExactlyTwo` 97.5% against a floor of 100%, one item in forty.

The two flagship failures from §7.10 are worth reading directly, because they are what the
idiom data was bought to fix:

| source | control | run 1 | run 2 |
|---|---|---|---|
| 걔는 귀가 얇아. | She's got thin ears. | She has thin ears. | She has thin ears. |
| 눈치 좀 챙겨. | Keep an eye on things. | Keep an eye on things. | Watch your back. |

`귀가 얇다` is "easily swayed" and `눈치` is "reading the room". All three runs translate the
first literally, and run 2 changes the second into a different wrong answer. **500 Korean idiom
sources did not fix the specific failure they were selected against**, at least not on these
two items.

None of this is the verdict. The primary criterion is the pairwise sign test against the
control, and it has not been run — the automatic metrics were never the thing being asked, and
§7.9 is on record that they disagreed with the judge before. What can be said now is narrower
and still worth saying: **if the tuning moved the target, it moved it by less than the
automatic instruments resolve, and the compliance gate fails regardless of how the judge
rules.** A candidate that loses on a hard gate does not need the judge to be disqualified from
shipping; the judge only decides whether the training taught anything.

### 7.14 A reproduction that argued for the wrong population (2026-09-02)

§7.11 could not recover run 1's swap behaviour after the fact, so it reproduced the
configuration for 100 iterations, measured zero swapouts, and concluded "the configuration does
not swap on a 24 GB machine". §7.12 already corrected the scope. Run 2's third leg finishes the
job of refuting it, and refutes the repair I had reached for in the meantime.

After leg 2 swapped heavily, the obvious suspects were the larger dataset and the fact that the
machine had been up for two days — fragmentation. I leaned toward fragmentation. Leg 3 settles
it: the machine had rebooted, swap in use was **0.00 MB** and free memory **79%** at the start,
and the leg still wrote **224,312 swapout pages**, took swap to **2,756 MB**, and bottomed free
memory at **11%**. A clean machine reaches the same state, so fragmentation is not the cause.

The remaining candidate is dataset size, and I am not claiming it either — the measurement that
separates training from evaluation was not taken. What is certain is that peak resident memory
is **15.616 GB in both runs**, identical to run 1's. The number quoted in §7.11 as evidence of
comfort is the same in the run that swaps and the run that does not.

The general point is about what a reproduction is evidence for. Reproducing a configuration
tells you about that configuration, and the conclusion was written about *the machine*. The
sampled window was 100 iterations of run 1's data; run 2 differed in the one dimension the
window held fixed. **A reproduction inherits the scope of what it varied, and generalising past
that is not a weaker claim, it is a different one.** The instrument that caught this is the
per-run sampler §7.11 introduced — the argument was wrong, and the record it was replaced with
is what showed it.

### 7.15 The judge inherited the product's token ceiling and lost the hardest items (2026-09-02)

Run 2's pairwise judging came back *38/40 items complete, 2 failed*, and the completeness gate
refused to compute a p-value on the subset (§9 of MEASUREMENT-NOTES). Re-running resumed from
cache and failed on the same two items, `hbx-idb-019` and `hbx-idc-013`, with the same message:
`Empty content in response`.

Reproducing the exact request outside the harness printed the cause:

```
finish_reason: "length" | native_finish_reason: "max_tokens"
content: null
reasoning: "\"손이 미끄러졌어\" explicitly names the hand, so it's more likely about a hand
            slipping and dropping something rather than the person themselves falling…"
```

`judge.js` calls the shared `apiClient`, whose `maxTokens` defaults to `DEFAULT_MAX_TOKENS`
— 2048, the extension's shipping ceiling. `claude-sonnet-5` bills reasoning tokens against that
budget, so on items where the two outputs are genuinely hard to separate it thinks past the
ceiling and the answer is never emitted. The fix is one line at each judge call site:
`maxTokens: JUDGE_MAX_TOKENS` (8192). The judge is not the product and has no reason to inherit
the product's limit.

Three things about the shape of this bug are worth keeping.

**It was content-dependent, so retrying could not fix it.** At temperature 0 the same prompt
produces the same reasoning and stops in the same place. A transient-failure retry loop would
have burned money to fail identically — and the two arms are judged from cache, so a naive
"skip the failures" would have silently made n=38.

**It selects against exactly the items that matter.** The requests that overrun the budget are
the ones where the judge deliberates longest, which is the same as saying the two outputs are
closest. Dropping them is not random attrition; it removes the items with the most information
about the difference being measured. A missing-data mechanism correlated with the effect is
worse than a smaller sample.

**Nothing in the response looked like an error.** HTTP 200, `finish_reason: "length"`, and a
populated `reasoning` field with a null `content`. Only the completeness gate — which exists
because of §9 and refuses to compute a statistic on a partial subset — turned it into a visible
failure instead of two quietly missing rows. The gate paid for itself here; no test was added
for the ceiling because the gate is the check, and it is the one that fires on the whole class
of "the judge did not answer" rather than on this one cause.

Rows already cached under the 2048 ceiling stay valid: at temperature 0 a larger budget only
permits more tokens, so a response that already finished with `stop` is unchanged. Run 1's
pairwise and absolute passes both completed with zero failures, so the ceiling never bound
there and no earlier number is affected.

### 7.16 The second run also failed the sign test (2026-09-02)

With all 40 items complete in both A/B orders and zero failures:

| criterion | candidate | control | ties | exact p |
|---|---|---|---|---|
| `natural` | 7 | 9 | 24 | 0.804 |
| `nuance` | 7 | 14 | 19 | 0.189 |

The criterion fixed before training was candidate wins > control wins on **both**, with
p < 0.05. **The candidate loses both. Run 2 failed.** As with run 1, "significantly worse" is
not established either — neither result clears p < 0.05 — so the honest statement is that
there is no evidence the idiom training helped, and the point estimate favours the untuned
model on both criteria.

Against run 1 (`natural` 5/12/23, p = 0.143; `nuance` 5/14/21, p = 0.064) the candidate's wins
rose from 5 to 7 on both criteria and the control's `natural` wins fell from 12 to 9. That is
movement in the right direction and it is not a result: on n=40 with 19–24 ties, differences of
two or three items are inside the noise the test exists to discount. Reporting it as progress
would be reading the point estimate of a test that just declined to reject its null.

**The absolute judge and the pairwise judge disagree, and the disagreement is the interesting
part.** On the same 40 items:

| criterion | control | run 1 | run 2 |
|---|---|---|---|
| `naturalFluent` | 75.0% | 70.0% | **67.5%** |
| `nuanceGrounded` | 27.5% | 30.0% | **45.0%** |
| `altsDistinct` | 50.0% | 55.0% | **42.5%** |
| `tipFactual` | 62.5% | 50.0% | **57.5%** |

`nuanceGrounded` rose 17.5 points, seven items — the largest movement this track has produced
and the first time a tuned candidate beat the control on the primary target by a margin worth
looking at. And the pairwise judge, given the same two outputs side by side, picked the control
on `nuance` twice as often as the candidate.

Both can be true. The absolute rubric asks "is this nuance note grounded?" of one output alone;
the pairwise rubric asks "which of these two is more specific and accurate?" A candidate can
clear the bar on more items in isolation while still being the weaker of the two on the items
where both clear it — the absolute score counts items, the pairwise score counts comparisons,
and a rubric that says *generic filler loses to a grounded explanation* discriminates between
two passes that the binary criterion cannot separate.

Which one is the criterion was fixed before any of this ran, and it is the pairwise test.
That ordering is the only thing that keeps this from being a choice made after seeing the
numbers — the absolute judge's +17.5 is precisely the number one would reach for. It is
reported here, and it does not change the verdict.

### 7.17 The number the verdict turns on was the one number not in the record (2026-09-02)

Every secondary measurement this project takes lands in `metrics.json` and the consolidated
`REPORT.md`: COMET, chrF++, fifteen compliance rules, latency percentiles, the absolute judge's
four criteria. The pairwise sign test — the **only** comparison the project claims significance
for — was printed to `judge.js`'s stdout and nowhere else. Two runs had been judged that way,
and the p-values survived only because they were copied by hand into the logs.

`judge.js` now writes `pairwise-summary.json` beside `pairwise.jsonl`; `score.py` embeds it into
`metrics.json`; both `report.md` and `REPORT.md` render it. Regenerating from the existing
caches cost nothing and reproduced both runs exactly, which is the cheapest possible check that
the hand-copied numbers were right.

Two choices inside that are the point of the entry.

**The summary is written by `judge.js`, not recomputed in `score.py`.** Python could easily
tally wins and run an exact binomial test, and then there would be two implementations of the
primary criterion that could disagree about ties, order-balancing, or which tail the test uses.
A statistic gets one home.

**It is written after the completeness gate, not before.** The gate throws when any item lacks
both A/B orders, so a partial run leaves its resume points on disk and no summary at all. The
alternative — write it, mark it partial — puts a number where a reader can find it and hope the
flag travels with it. Absent is a stronger guarantee than labelled.

The general failure is worth naming because it is quiet: **the measurements that reach the
report are the ones some pipeline already carries, not the ones that matter most.** Nothing was
wrong with any number here. The criterion had simply never been wired into the artefact anyone
would read, and the run that failed it was the second one, not the first.

### 7.18 The direction split says the gain did not come from the idiom data (2026-09-02)

Run 2's one encouraging number was `nuanceGrounded`, 27.5% → 45.0% against the control. The
cheapest way to ask whether the idiom data earned it is to split by direction, because the
data can only have touched one of them.

Every NIKL source sentence is Korean, so every record it produced is a `ko_to_en` example. The
training sets confirm it — counted from each record's `detected_lang`:

| | KO source (`ko_to_en`) | EN source (`en_to_ko`) |
|---|---|---|
| run 1 `teacher/train` | 449 | 447 |
| run 2 `teacher-run2/train` | **898** | **447** |

`en_to_ko` received **zero** new training records between the two runs. If the idiom sources
taught idiom handling, the improvement should be lopsided toward `ko_to_en`. Against the
control:

| criterion | `ko_to_en` control → run 2 | `en_to_ko` control → run 2 |
|---|---|---|
| `naturalFluent` | 16/20 → 14/20 (−2) | 14/20 → 13/20 (−1) |
| `nuanceGrounded` | 1/20 → 5/20 (**+4**) | 10/20 → 13/20 (**+3**) |
| `altsDistinct` | 12/20 → 8/20 (**−4**) | 8/20 → 9/20 (+1) |
| `tipFactual` | 9/20 → 11/20 (+2) | 16/20 → 12/20 (−4) |

**It is not lopsided.** The trained direction gained four items on `nuanceGrounded` and the
untrained one gained three — and correcting for headroom makes the untrained direction look
*better*, not worse: `ko_to_en` started at 1/20 and captured 4 of its 19 available items (21%),
while `en_to_ko` started at 10/20 and captured 3 of 10 (30%).

A direction that received no new data cannot have learned anything direction-specific from it.
Whatever moved `nuanceGrounded` moved both directions roughly equally, which is what a general
change in output style looks like — the model writing longer, more particular-sounding nuance
notes because that is what the teacher's records look like. That is the same thing §7.10 said
the loss curve was measuring: format, not phenomenon. The idiom sentences added 449 more
examples of the teacher's writing, and the writing is what transferred.

**The direction that did get the data is also where the worst regression is.** `altsDistinct`
fell 12/20 → 8/20 in `ko_to_en` and rose 8/20 → 9/20 in `en_to_ko`. Four items is not a result
on n=20, but it is the opposite of the sign the data was bought for, and it is in the only
direction the data could reach.

**Confidence limits.** Every cell is n=20, so ±3 items is within what this table can resolve
and none of these movements is individually significant; no p-value is computed per direction
for exactly that reason (`score/direction_split.py` reports counts only). The comparison used
throughout is control → run 2, not run 1 → run 2, because run 1 differs in epochs and in having
run uninterrupted, and attributing a difference to data while two other things changed is the
error this whole split exists to avoid.

What the split does support is narrow and useful: **the improvement is not evidence that the
idiom sources worked.** Buying more of them, or better ones, is not the obvious next move it
looked like an hour ago.

### 7.19 A fifteen-minute probe that replaced an eight-hour guess (2026-09-02)

The direction split (§7.18) removed the reason to buy more idiom data, which left capacity as
the remaining hypothesis with a mechanism behind it. Runs 1 and 2 both used `num_layers: 8` —
the last 8 of Qwen3-14B's **40** transformer blocks, the final fifth of the stack, 6.4M
trainable parameters or 0.043% of the model. An adapter confined there can reshape how the
model phrases an answer and never touches where lexical and idiomatic meaning is resolved.
That predicts precisely the split that was observed: style transferred, phenomenon did not.

The obvious next run is the same configuration at `num_layers: 40`. Rather than start it and
find out, a 40-iteration probe measured what it costs. It cost fifteen minutes and returned
something the run would have discovered three hours in:

```
RuntimeError: [METAL] Command buffer execution failed: Insufficient Memory
```

Free memory bottomed at 6% and the probe wrote 99,844 swapout pages before dying. Backward
through all 40 blocks stores five times the activations, and 24 GB does not hold them.

`grad_checkpoint: true` recomputes activations in the backward pass instead of holding them.
The second probe:

| | run 2 (`num_layers: 8`) | probe (`num_layers: 40`, checkpointed) |
|---|---|---|
| peak memory | 15.616 GB | **11.901 GB** |
| free memory, min | 11% | 27% |
| new swapouts | 224,312 | **0** |
| it/sec | 0.108 | 0.052 |

**Training five times as many blocks uses less memory than run 2 did.** That number is worth
sitting with, because it reinterprets §7.14. That entry established that run 2's swapping was
not fragmentation and pointed at dataset size while explicitly declining to claim it. The real
answer is now visible and it was neither: **the memory runs 1 and 2 paid for was stored
activations, and the flag that eliminates them was available the whole time.** The swap was not
the price of the run's size. It was the price of a default.

The cost of the fix is wall clock — 0.052 it/s makes one epoch about 7.2 hours plus three
evaluations — and it is not a second variable in the comparison. Gradient checkpointing changes
what is held in memory, not what is computed; the gradients are identical, so run 3 still
differs from run 2 in exactly one thing that can affect learning.

The transferable part is the probe itself. **A configuration change whose cost is unknown gets
measured at 40 iterations before it gets run at 1,345.** The failure here was not subtle and
would have shown up early either way, but the useful output was not the crash: it was
`0.052 it/s` and `11.901 GB`, two numbers that turned "roughly how long?" into a schedule and
an evaluation interval chosen to keep evaluation under 4% of wall clock.

### 7.20 The training set is unbalanced by direction, and the holdout moved with it (2026-09-02)

§7.18 counted the training set by direction to attribute run 2's one improvement. Those counts
carry two facts about the data that had not been written down as defects, only used as a
measuring instrument.

| | `ko_to_en` | `en_to_ko` |
|---|---|---|
| run 1 `teacher/train` | 449 (50%) | 447 (50%) |
| run 2 `teacher-run2/train` | 898 (**67%**) | 447 (**33%**) |
| eval `handbuilt-ext.jsonl` | 20 (50%) | 20 (50%) |

**The training set is 2:1 toward one direction while the evaluation is 1:1.** Run 1 was
balanced; adding the idiom sources made run 2 lopsided, because every NIKL source is Korean.

The sharper version of the same fact is worse than the ratio. All 447 `en_to_ko` records are
FLORES prose, so **`en_to_ko` contains zero idiom examples** — while all 20 of the evaluation's
`en_to_ko` items are idioms. Half the thing being judged was never trained for at all. The
existing note (MEASUREMENT-NOTES §13) recorded that no `en_to_ko` idiom source had been found
and left it at that; what it did not say is that this makes run 2 a half-treatment measured
against a whole test.

**The holdout moved too, so two loss numbers that look comparable are not.** `teacher/valid`
is 100 records at 49/51; `teacher-run2/valid` is 150 at 99/51. Run 1's final holdout loss of
0.859 and run 2's 0.885 are computed over different sets with different composition. No entry
in this log compares them directly, but nothing warned against it either, and the natural
reading of "0.859 then 0.885" is a regression that the numbers cannot support. **Neither run's
holdout loss is evidence about the other.**

None of this changes what has already been concluded, and it is worth being exact about why:

- **Run 3 is unaffected.** It trains on the same `teacher-run2` data as run 2, so the imbalance
  is held constant and cannot explain a difference between them. That is what changing one
  variable buys.
- **§7.18's attribution is unaffected, and if anything strengthened.** The argument is that the
  direction which received *no* new records improved as much as the one that received 449. A
  larger imbalance makes that contrast sharper, not weaker.
- **It does not resurrect the data hypothesis.** "Balance the directions and add `en_to_ko`
  idioms" is the obvious repair, and §7.18 is the reason not to reach for it: adding 449
  `ko_to_en` idiom records did not produce `ko_to_en` idiom skill. There is no mechanism by
  which the same treatment in the other direction would behave differently.

It does produce one concrete thing to watch. **If run 3 improves `ko_to_en` and not `en_to_ko`,
the imbalance becomes the first suspect rather than a footnote** — that would be depth
unlocking the data that exists, and the missing half of the data would then be the binding
constraint. `score/direction_split.py` answers it for free. Writing the prediction down before
the run finishes is what keeps it from being a story assembled around whatever comes back.
