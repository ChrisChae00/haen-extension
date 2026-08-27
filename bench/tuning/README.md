# bench/tuning — the LoRA track's serving artifacts

Scripts that build the models the tuning comparison runs on. Everything here is
reproducible from a cached base checkpoint; the multi-GB outputs are not committed.

```
lora-run1.yaml            Phase 5's first training run, with the reasoning in comments
make_zero_adapter.py      builds a LoRA adapter that provably changes nothing
verify_zero_fuse.py       proves the fused control is the base model, and measures the
                          fuse round trip's own noise floor
prepare_ollama_import.py  writes mode=affine into a fused config.json so Ollama's
                          experimental importer reads it as 14.8B int4, not 1.8B bf16
```

## Why an untuned control exists

The tuned candidate does not differ from the product baseline (`qwen3:14b`, Q4_K_M,
standard Ollama runner) by weights alone: it is served through the experimental
Safetensors runner, quantised as MLX int4 affine, with a different template. A
tuned-vs-product-baseline delta therefore cannot say whether LoRA caused it.

The control is the same pipeline with the weights left alone — MLX initialises `lora_b`
to zeros and `fuse()` computes `weight + (scale · lora_bᵀ) @ lora_aᵀ`, so an untrained
adapter fuses as `weight + 0`.

## Rebuilding the control

```bash
uv venv --python /opt/homebrew/bin/python3.13 .venv-mlx      # Homebrew, not Anaconda:
VIRTUAL_ENV=.venv-mlx uv pip install "mlx-lm==0.31.3"        # Anaconda exposes MPICH and MLX exits

.venv-mlx/bin/python bench/tuning/make_zero_adapter.py --out bench/tuning/zero-adapter
.venv-mlx/bin/python -m mlx_lm.fuse \
  --model mlx-community/Qwen3-14B-4bit \
  --adapter-path bench/tuning/zero-adapter \
  --save-path bench/tuning/fused-untuned-control
.venv-mlx/bin/python bench/tuning/prepare_ollama_import.py bench/tuning/fused-untuned-control
.venv-mlx/bin/python bench/tuning/verify_zero_fuse.py

cd bench/tuning && printf 'FROM ./fused-untuned-control\n' > Modelfile.untuned-control
ollama create --experimental haen-qwen3-14b-untuned-control -f Modelfile.untuned-control
ollama show haen-qwen3-14b-untuned-control      # MUST say 14.8B / int4
```

Then measure it like any other model:

```bash
node src/run.js --config configs/qwen3-14b-untuned-control-ext.json
```

## Three things worth not rediscovering

**`ollama show` is the import check, and a bad import does not error.** A fused config
without `"mode": "affine"` imports "successfully" and reports 1.8B / bfloat16. Two of the
three spike tags in this project were that failure and looked fine from the outside.

**The experimental runner ignores `reasoning_effort` and obeys `/no_think`.** Measured on
this control: `reasoning_effort: "none"` produced 493 characters of `<think>`, while
`/no_think` appended to the user message produced an empty think block followed by the
answer, which `stripThinking` removes. That is what the `promptSuffix` config field
carries, and why it is folded into `promptHash` — without it, a thinking run and a
no-think run on this runner are indistinguishable in every recorded field.

**The fuse round trip is not lossless, which is the argument for this control rather than
importing the base checkpoint directly.** `fuse()` dequantises and re-quantises every
LoRA-targeted layer even when the delta is zero. Measured: 56 of 282 quantised layers
re-quantised (exactly the LoRA targets — rank 8, top 8 layers), 226 untouched, all 161
unquantised norm tensors bit-identical. Worst single weight moved 0.09375 where that
layer's largest weight is 1.15625; mean |diff| across re-quantised layers 2.6e-4. Small,
but not zero — and the candidate pays the same cost, so with this control it cancels
instead of being attributed to LoRA.

## Training a candidate

```bash
../../.venv-mlx/bin/python -m mlx_lm lora -c lora-run1.yaml
```

Outputs land in `adapters-run1/` (gitignored): `adapters.safetensors` plus a numbered
checkpoint every `save_every` iters. Serve one exactly like the control — same fuse, same
affine injection, same `ollama show` check — pointing `--adapter-path` at this directory.

Run 1 measured: 6h08m for 1,792 iters, peak 15.617 GB of 24 GB, holdout loss 1.566 -> 0.859.

## Two more things worth not rediscovering

**`iters` counts micro-batches, not optimizer steps.** `trainer.py` runs
`zip(range(1, iters+1), iterate_batches(batch_size=...))`, so at `batch_size: 1` one iter is
one training record. With 896 records and `grad_accumulation_steps: 8`, `iters: 500` is 0.56
of an epoch and 62 Adam updates - not enough to move a rank-8 adapter, and a run that changes
nothing is an uninformative null rather than a negative result. Divide `Trained Tokens` by the
iteration count in the first report line to check this before letting a run continue.

**Validation batches are shuffled, so `val_batches` cannot be reduced for speed.**
`iterate_batches` draws them through `np.random.permutation`, which means a reduced count
scores a different random subset at every evaluation and the losses are not comparable across
evaluations - the one thing the holdout is for. Full holdout costs 645-705s here; take fewer
points instead of fewer items. Run 1's decisions turned on differences of 0.008 and 0.002,
which a resampled subset would have buried.
