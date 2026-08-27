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
