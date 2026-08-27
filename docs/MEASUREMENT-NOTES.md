# Harness measurement-accuracy notes

Written 2026-08-18. Subject: the `bench/` harness, base commit `7977a87`.

## Why this document exists

The bugs written up here are **the kind tests do not catch**. The harness exits cleanly,
predictions.jsonl is written normally, and the report renders nicely. Only the numbers are wrong —
and not as "obviously strange values" but as "plausible but biased values".

Later, reading the code alone cannot reconstruct why they were fixed that way. So the symptom, the
impact, the chosen solution, and the rejected alternatives are recorded.

How they were found: right after finishing the first three model measurements (gemini 212×2,
llama 15×2, qwen 55×1) and publishing `bench/REPORT.md`, `/code-review` was run over the harness.
It produced 8 findings; the 4 below are the ones that distort the measurements themselves.

---

## 1. A streaming failure silently becomes a non-streaming re-request

**Where** `src/apiClient.js:204`

**Symptom** When the stream body breaks with `InvalidResponseError` (truncated or malformed JSON —
a common streaming failure), `translate()` re-sends the entire request with `onChunk: undefined`.
That re-request's `onRaw` fires a second time carrying `meta = { ttfbMs: null }`, overwriting the
first streaming meta the harness was holding.

**Which numbers go wrong, and how**

- `ttfbMs` becomes `null` and is dropped by the `r.get("ttfbMs") is not None` filter at
  `score.py:149` → **exactly the items where streaming was actually a problem fall out of the TTFB
  percentiles.** The remaining sample is a survivorship-biased set of "cases where streaming went
  well", and the report calls it "streaming TTFB p50/p90/p99"
- `raw` is also overwritten by the second (non-streaming) response, so **compliance scores the
  non-streaming path**. It claims to measure streaming parsing while actually measuring the quality
  of the fallback path
- `retries` is counted as 1, but that 1 does not distinguish "429 retry" from "stream fallback"

All three configs have `"stream": true`, so all are affected.

**Chosen solution — do not remove it; measure its rate and expose it**

`src/apiClient.js` is left alone. The harness's `onRaw` (`bench/src/providers/haen.js`) preserves
the first non-null `ttfbMs` and records the fact that an overwrite happened as
`streamFallback: true`. `score.py` aggregates it as `streamFallbackRate` and always prints it in
each model's `report.md` (printed even at 0% — the fact that it is 0% is itself the evidence that
the TTFB statistics are clean).

**Why apiClient was not fixed**

This fallback is not a bug; it is **intended production behaviour**. When a stream breaks, the user
gets one more attempt and a complete response rather than an error. The whole reason the benchmark
exists is that it "measures the code path users actually take" (comment at the top of
`bench/src/providers/haen.js`), so turning that path off for measurement convenience would make the
thing measured differ from the user's. That is a worse kind of inaccuracy.

**Rejected alternatives**

- *Add a `disableNonStreamFallback` option to apiClient* — puts a bench-only branch into production
  code. The measurement gets clean, but for the reason above the thing measured drifts
- *Just exclude fallen-back items from the statistics* — identical to the current state (implicit
  exclusion) and hides the bias. The goal is to expose it, so this is the exact opposite

---

## 2. Key-rotation wait mixed into latency

**Where** `bench/src/providers/haen.js:42`

**Symptom** `const started = performance.now()` sits **outside** the key-rotation `for(;;)` loop.
When a key dies of quota exhaustion and the next one is taken, the request against the dead key plus
apiClient's internal retry backoff (`e.retryAfterMs`, or 500ms + 1500ms without it) all get summed
into `latencyMs`.

**Which numbers go wrong, and how** The few items where rotation occurred become samples of seconds
to tens of seconds and drag p90/p99 up wholesale. The latency tail in the report reads as "the model
was slow" but actually means "the harness burned through a dead key".

**Chosen solution** Move `started` to the first line of the `try` inside the loop. Only the request
on the successful key is instrumented.

**Why this is right** The definition of the latency column is "the delay a user experiences". A user
has exactly one key; stitching quota together across multiple accounts is purely a harness
circumstance. Including rotation time means calling a delay no user will ever experience a user
metric.

The fact that discarded attempts happened is still preserved in `retries` (= `attempts - 1`), so no
information is lost.

---

## 3. `minIntervalMs` is not a rate limiter

**Where** `bench/src/run.js:76` (`mapPool`)

**Symptom** The sleep is applied **after an item completes**. So the effective RPM is
`concurrency / (latency + minIntervalMs)`, not `60000 / minIntervalMs`. With `concurrency: 2`,
1s latency and `minIntervalMs: 4200`, requests per second come out at twice the intent.

Incidentally, a worker also sleeps once after finishing its last item, so every run throws away
`concurrency × minIntervalMs` doing nothing.

**Which numbers go wrong, and how** Right now, nothing is wrong —
`bench/configs/gemini-3.5-flash-lite.json` has `concurrency: 1`, so it is **accidentally** correct.
The problem is that the assumption is nowhere in the code. Anyone raising concurrency to 2 for
throughput would quietly blow past Google's 15 RPM cap and get a storm of 429s instead of
measurements.

**Chosen solution** A two-line fix:
- do not sleep after a worker's last item
- if `minIntervalMs` is set and `concurrency > 1`, **die with an error**

**Why a real rate limiter was not built** A token bucket or sliding window is overkill for this
workload. Exactly one provider needs pacing today (the Google free tier), and that one is measured
perfectly well at `concurrency: 1` (verified over 424 requests with 0 failures). A guard that states
the assumption in code gives the same safety in two lines. The day multi-worker pacing is genuinely
needed, it can be promoted to a rate limiter — and by then what it needs to do will be clearer too.

---

## 4. One `fetchedAt` has a different date

**Where** `bench/src/pricing.js:13` — only `llama-3.1-8b-instant` is `'2026-08-05'`; all other Groq
rows are `'2026-08-09'`.

**Symptom** `fetchedAt` is not decoration; it is the basis for the report's "prices as of" line
(`score.py:180` → report.md). A single lagging date means one of two things: (a) it was re-verified
and the date was not bumped, or (b) it was not re-verified, and the date updates on the other rows
are just as untrustworthy.

**Rule** — going forward, when touching this table:

> Write into `fetchedAt` only **the day the value was actually seen with your own eyes in the
> provider's documentation**. If it could not be checked, touch neither the value nor the date. The
> moment a date is bumped "to match the other rows", the field becomes a lie, and then there is no
> point having it.

`llama-3.1-8b-instant` is not used by any config today, so this is not urgent. Verify it when it can
be verified; otherwise leaving the old date is the right thing — an old date is information, a wrong
date is contamination.

---

## Impact on numbers already published

The gemini and llama rows in `bench/REPORT.md` (as of 2026-08-18) were **measured with the harness
before these fixes**.

| Metric | Impact |
|---|---|
| COMET / chrF++ / BLEU | None — translation-quality computation is unrelated to these bugs |
| Compliance rates | Scores the non-streaming path for however many items fell back. Rate unknown, so magnitude unknown |
| Streaming TTFB p50/p90/p99 | **Survivorship bias.** Fallen-back items are missing entirely |
| latency p90/p99 | Inflated if key rotation occurred. No impact on single-key runs |
| cost / 1k | None |
| determinism | None |

Since the data predates `streamFallbackRate`, **the magnitude of the bias cannot be established
after the fact**. Hence the re-measurement. If that rate comes out at 0%, it means the old numbers
were clean after all.

---

## 5. Ten items recorded as thinking nothing when the provider sent no total

Found in review of the thinking-budget work, after the `gemini-3.7-flash` run was published.

`reasoning_tokens` is derived as `total − prompt − completion`. When Google's response carried no
`total_tokens`, that expression became `0 − prompt − completion`, a large negative, and the
`Math.max(0, …)` guard clamped it to **0** — indistinguishable from a model that genuinely thought
nothing.

It happened. In `bench/results/20260821T181157-gemini-3.7-flash/predictions.jsonl`, **10 of 424
records** carry `reasoning_tokens: 0` with no error and a full hypothesis, while the other 414 have
a minimum of 16 and a median of 315. All ten are missing `total_tokens`.

- **Fix**: prefer the provider's explicit `completion_tokens_details.reasoning_tokens`; derive the
  gap only when `total_tokens` is present; record `null` — not `0` — when it is not.
  `score.py` sums what is known, counts what is not, and marks the cost a lower bound
- **Not recoverable**: `total_tokens` was never persisted, so those ten cannot be re-derived from
  disk. Only a re-run of those items would settle them
- **Impact on the published number**: the run's `reasoningTotal 72,667` and `$3.0176` are floors,
  understated by roughly 3,150 tokens (~4%). Left as a marked lower bound rather than re-measured —
  a 4% correction is not worth a row measured half in August and half later

The same mechanism means every run predating the field (`qwen3.6-27b`, both `gpt-oss` rows,
`gemini-3.5-flash-lite`, `qwen3-14b-local`) now reports `reasoningTotal: None` instead of `0`, and
their costs carry the `≥` mark in `bench/REPORT.md`. **The cost column is not rankable across
marked and unmarked rows.**

---

## Related open issue (out of scope here)

**No timeout on reading the stream body** — the 30-second timeout at `src/apiClient.js:235` only
covers the fetch up to headers and is `clearTimeout`-ed at `:275`. After that, `reader.read()` in
`_handleStream()` has no timeout at all, so if the socket dies quietly it neither resolves nor
rejects.

- In the harness: `kill -STOP` then `kill -CONT` on a running run hangs the process permanently
  (observed after 4 hours: 0 sockets, 0 progress, 24s CPU). **To stop a run, use `kill -9` only**
- In real use: if the network drops mid-stream, the UI is stuck loading forever. A real bug, and a
  production one rather than a harness one. To be handled separately

**`max_tokens: 2048` hardcoded** — in the `src/apiClient.js` fetch body. Groq deducts TPD/TPM
against the request's `max_tokens` reservation rather than actual usage, so a real completion of
~300 tokens reserves ~2,800. This is the direct cause of the 200,000 TPD free tier shrinking to
~71 calls a day. Left alone because it is production code.

---

## 6. Fine-tuning comparison invariants

The Phase 1–4 review added four requirements for any tuning result:

1. Pairwise runs are comparable only when dataset, prompt, scoring version, UI language, generation
   settings, JSON/streaming mode and no-think transport all match.
   *Enforced since 2026-08-26 by `validateComparableConfigs` (`bench/src/judge.js`), which compares
   `promptHash`, `scoringVersion`, `harness`, `uiLanguage`, `temperature`, `jsonMode`, `stream` and
   `reasoningEffort` alongside dataset identity. Git sha is excluded on purpose — a tuned run is always
   later than its baseline. No-think transport is still not in `promptHash`; that half is open.*
2. A success p-value is invalid unless every requested item has both A/B orders. Partial rows may be
   resumable checkpoints, but the command must refuse a success summary and exit non-zero.
   *Enforced since 2026-08-26: `judge.js --baseline-run-dir` throws before printing any sign test if any
   requested item lacks a complete two-order row. The rule was written a week before the code obeyed it,
   and in between the command would happily print `p=0.021` computed on 28 of 40 items.*
3. Report two comparisons: tuned experimental runner vs product baseline for the end-to-end product
   decision, and tuned vs untuned on the same experimental runner for LoRA attribution.
4. The manual regression set is a committed/frozen list of 20 IDs with item-level judgments, selected
   before candidate outputs are inspected.

Compliance aggregated 14 implemented checks until 2026-08-26. It did not verify that `detected_lang` and
`target_lang` agreed with the requested direction; non-empty wrong tags passed. `langTagsMatchDirection`
closes that (`scoringVersion` 2), so "15-rule compliance" is now accurate.

*What the 15th check found*: `flores-ke-0007` fails on the product baseline in all three runs with the
tags exactly reversed - reproducible, and invisible to every other instrument, since COMET scores
`natural` and never reads the tags. It does not become anyone's worst rule, so no published number moved
and the `>= 99.53%` tuning regression threshold survives the count change.

*Reporting a check that predates its rows.* Historical runs have no `langTagsMatchDirection` key at all.
Counting an absent key as `False` would print a brand-new check as 0% for every historical model - a
measurement that never happened, published as total failure. `compliance_rates()` now takes its
denominator per key, over the records that actually carry it, and `npm run rescore` re-derives a finished
run's compliance from its stored raw output when the real number is wanted (no API calls; it touches
nothing but the `compliance` block).

**Why these two took a second review to close.** They were written into this document by the Phase 1–4
review and then left as prose. The code around them looked complete — `validateComparableConfigs` reads
like a full comparability guard, and the pairwise runner counts and reports its failures — so nothing
prompted a reader to check the rule against the implementation. A documented invariant that no test
asserts is a comment, not a guard.

---

## 7. A hash that could not see the thing it was hashing (2026-08-26)

`promptHash` is the field the whole comparability story rests on, and it hashed only
`buildSystemPrompt()`. The tuning track's serving path - Ollama's experimental runner - ignores
`reasoning_effort` entirely and switches thinking on and off from Qwen3's `/no_think` tag in the
message. So the single control that changes what the model *does* most on that path was not in the
hash, and two runs differing by exactly that control were indistinguishable in every recorded field.

**Chosen**: a `promptSuffix` config field, applied to the user message and hashed unconditionally.

**Rejected - hashing it only when set**: it reads as the careful option (don't disturb existing
hashes) and is the trap. A conditional hash means "no suffix" and "a suffix that happens to be empty"
take different code paths through the one function that must have none. `hash.update('')` is already
a no-op, so unconditional hashing costs nothing and every historical `promptHash` is unchanged -
asserted against the literal `3d18dda71bc9...` in `src/run.test.js`, because if that value ever moves,
every row of `bench/REPORT.md` becomes incomparable at once.

**Rejected - putting the tag in the system prompt**: the standard Ollama runner is documented to
ignore `/no_think` in the system position, so the same config would mean "thinking off" on one runner
and nothing at all on another. The user message works on both.

---

## 8. A format check that measured the transport (2026-08-27)

**Where** `bench/src/compliance.js` — `prosePreamble`, `fenced`

**Symptom** The untuned control scored `prosePreamble` 0 of 40. Every response was flagged as having
prose in front of the JSON. None did.

**Cause** `/no_think` makes Qwen3 emit an empty `<think></think>` before the answer, so the raw body
no longer starts with `{`. `apiClient` strips that block before parsing and the user never sees it,
but the check read the raw text.

**Which numbers go wrong, and how** Not the ones already published — this only bites a transport that
emits reasoning tags, and every recorded run either emits none or emits untagged prose. It bites the
tuning track exactly: the summary table reports the *worst* rule, so both the tuned candidate and its
control would have published **0% compliance**, on a serving detail, next to models measured without
it. A cross-model column where one row is 0% for a reason unrelated to the model is worse than no
column.

**Chosen solution** Evaluate `fenced` and `prosePreamble` on the thinking-stripped body — the text
the client parses and the user receives. `empty` still reads the raw text: it asks whether a response
arrived at all, which is a transport question, while the other two ask whether the model formatted
its answer as instructed. `scoringVersion` 3.

**Rejected — special-casing an empty think block.** Tempting, since the empty one is the artefact and
a non-empty one is the model actually thinking. But a model that thinks and *then* writes prose before
its JSON has still written a preamble, and one that thinks and then opens a fence has still fenced. The
question the check asks is about the answer, so the answer is what it should read; where the reasoning
ended up is a different question, already answered by `reasoningTokens` and the latency split.

**Rejected — leaving it and annotating the report.** The number would still be wrong in
`metrics.json`, which is what every downstream comparison reads.

**What was verified before changing it** `qwen3.6-27b`'s 97 flagged items are genuine untagged prose,
so its published 54.2% `noPreamble` is real and unchanged. Across all 3,545 stored records the fix
moves exactly the 40 control rows.

### The scoring version had two meanings

Bumping `scoringVersion` for the fix made the new run incomparable to every older one: the field is
stamped into `config.json` at run time and `validateComparableConfigs` compares it, so a run whose
compliance had just been re-derived by the current code still advertised the version it was recorded
under. It now means **the version that computed the stored compliance** — `npm run rescore` stamps it
after re-deriving — and judge verdicts are covered separately by their own `rubricHash`. The constant
lives in `compliance.js` with a changelog, `run.js` imports it, and `test_score.py` fails if the Python
mirror drifts.
