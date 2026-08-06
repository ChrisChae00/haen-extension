# Haen benchmark harness

Measures translation quality, instruction compliance, latency and cost for any model
Haen can call — hosted or local — and writes versioned, reproducible results.

It exists so that swapping the model is a measurable change rather than a vibe. Before
fine-tuning anything, there has to be a baseline; this produces it.

## Quick start

```bash
cd bench
npm test                                    # compliance checks

# 1. one-off: fetch and sample FLORES-200 (see src/sampleFlores.js for the download step)
npm run sample-flores

# 2. see what a run would cost before spending anything
node src/run.js --config configs/<name>.json --dry-run

# 3. run it
export GROQ_API_KEY=...
node src/run.js --config configs/<name>.json

# 4. score it
python3 -m venv .venv && .venv/bin/pip install -r score/requirements.txt
.venv/bin/python score/score.py --run-dir results/<run-id>
```

Add a model: copy `configs/_template.json`, add a row to `src/pricing.js`. Nothing else.

## Layout

```
configs/        one JSON per model under test
datasets/v1/    flores.jsonl (derived, seed-pinned) + handbuilt.jsonl (authored)
src/            Node runner - imports the extension's real apiClient
score/          Python scorer - sacrebleu + COMET
results/        run output (gitignored, keep locally forever)
```

Node runs the models, Python scores them. The split is deliberate: the runner imports
`src/apiClient.js` and `src/prompts.js` directly so the benchmark exercises the exact code
path users hit — a Python reimplementation would drift from the shipping prompt and the
baseline would quietly stop meaning anything. The metrics only exist in Python.

## What gets measured

**Quality (COMET, primary).** `Unbabel/wmt22-comet-da`, reference-based, Apache-2.0.
Works in embedding space, so a valid paraphrase scores as a valid paraphrase.

**Quality (chrF++/BLEU, secondary).** Reported for comparability with published KO↔EN
numbers, not for decisions. Two reasons they mislead here: Korean is agglutinative, so
BLEU's word tokenization treats `먹었어요` and `먹었습니다` as unrelated (chrF++ is
character-level and survives this); and `natural` is not raw MT output — it is generated
alongside a `literal` field, so a model correctly making `natural` more idiomatic gets
*penalised* on n-gram overlap.

**Compliance.** Haen returns structured JSON, not a string (see `src/prompts.js`). Valid
JSON, required fields, exactly two alternative categories, 1–3 expressions each, valid
register values, no Hanja in Korean-written fields, no fences, no salvage fallback. Needs
no references, costs nothing, and predicts user-visible breakage far better than BLEU.

**Structured-output quality (LLM-as-judge).** Compliance only asks whether `nuance`
exists, not whether it says anything. A 50-item subset gets a binary rubric —
`naturalFluent`, `nuanceGrounded`, `altsDistinct`, `tipFactual`. Binary because five-point
rubrics make LLM judges unstable. Judge must not be a model under test; `judge.js` refuses
if it is.

**Operational.** Latency p50/p90/p99 (wall-clock around the whole call, retries included,
because that is what a user waits for), token usage, cost per 1,000 translations, failure
rate by error type, retry rate.

## Reading the numbers

**Absolute scores mean nothing.** COMET 0.84 is not a fact about anything. Only deltas
between models on the same dataset are.

**Two models within 2× runVariance are tied.** Every config runs 3×, because
`temperature: 0` does not mean deterministic — batched serving stacks reorder
floating-point accumulation depending on batch composition. `identicalOutputRate` measures
how deterministic temperature 0 actually is; the stdev across runs is the noise floor any
claimed improvement has to clear. This is deliberately kept separate from the bootstrap
confidence interval, which measures a different thing (item-sampling variance).

**No per-slice quality scores, by design.** Slices (`news`/`technical`/`casual`/`ui`) are
tagged and carried through, but 50 items per slice gives a confidence interval wider than
any plausible between-slice gap — a per-slice chrF table would be noise formatted as a
result. Slices get compliance rates (proportions stay meaningful at n=50) and
`score.py --slice casual`, which dumps individual outputs to read rather than a number to
misread.

**FLORES scoring far above hand-built is a contamination signal**, not a skill signal.
FLORES is public and sits in every model's training data. It is in the set as a tripwire:
if hand-built scores climb while FLORES doesn't, the references have drifted toward
personal taste.

**Judge scores are relative only.** Judges have self-preference bias and are not
comparable across judge model versions. The judge id is recorded in `config.json`.

## Reproducibility

Every run writes `config.json` with the resolved model id, temperature, dataset checksums,
git SHA and dirty flag, harness version, Node version, judge model id, `scoringVersion`,
and a **prompt hash** — SHA-256 of the actual system prompts used.

The prompt hash is the one that earns its keep. Model ids and dataset versions are easy to
remember; a quietly edited sentence in `src/prompts.js` is not, and it moves scores as much
as a model swap. If two runs disagree and their prompt hashes differ, the comparison was
never valid.

Two rules that are easy to break and expensive to notice later:

- **Never put an evergreen alias in `modelId`.** `gemini-flash-latest` is right for the
  extension and fatal for a baseline.
- **Never delete `predictions.jsonl`.** It is gitignored but must stay on disk.
  Re-scoring old runs with a new metric or a revised judge rubric needs the raw outputs,
  and regenerating them costs money.

Prices in `src/pricing.js` carry a `fetchedAt` date and `report.md` prints it, because
providers change prices silently and a stale cost report looks exactly like a correct one.

## Not used, and why

`Unbabel/wmt22-cometkiwi-da` (reference-free QE) would have removed the need to author
references and allowed a much larger set. It is gated on HuggingFace and licensed
CC-BY-NC-SA. A non-commercial dependency in the eval pipeline of a publicly distributed
extension is the wrong trade, so the reference-based path was kept and the hand-built set
capped at what can actually be authored.
