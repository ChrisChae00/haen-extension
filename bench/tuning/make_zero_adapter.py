"""Build a LoRA adapter that provably changes nothing, for the untuned control.

The tuning candidate is not just "the baseline with new weights": it is served through a
different runner (Ollama's experimental Safetensors import), a different quantisation
(MLX int4 affine), and a different template. Comparing it only against the product
baseline (`qwen3:14b`, Q4_K_M, standard runner) cannot say whether a delta came from LoRA
or from the serving stack. The control that can is a model that took *exactly* the same
path with the weights left alone.

MLX initialises `lora_b` to zeros, and `LoRALinear.fuse()` computes
`weight + (scale * lora_b.T) @ lora_a.T`, so an untrained adapter fuses as `weight + 0`.
Fusing it therefore runs the whole pipeline - dequantise, add zero, re-quantise, save,
import - while leaving the model mathematically identical to the base checkpoint.

That re-quantisation round trip is the reason this is better than importing the base
checkpoint directly: the candidate will go through it too, so the control has to as well,
and any perturbation it introduces then cancels out of the comparison instead of being
attributed to LoRA. `verify_zero_fuse.py` measures what that round trip actually costs.

The LoRA shape here must match the shape Phase 5 trains with (rank 8, top 8 layers), or
the control passes through a different set of fused layers than the candidate does.
"""

import argparse
import json
from pathlib import Path

from mlx.utils import tree_flatten
import mlx.core as mx

from mlx_lm.utils import load
from mlx_lm.tuner.utils import linear_to_lora_layers

# Phase 5's planned configuration (docs/local/FINETUNING.md 5.2). Kept here as literals
# rather than read from a training config, because this script must keep working if the
# training run is re-tuned - the control's job is to match the *shape* that was actually
# used, and a mismatch should be a deliberate edit, not a silent inherit.
NUM_LAYERS = 8
LORA_PARAMETERS = {"rank": 8, "scale": 20.0, "dropout": 0.0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="mlx-community/Qwen3-14B-4bit")
    parser.add_argument("--out", default="bench/tuning/zero-adapter")
    args = parser.parse_args()

    model, _ = load(args.model)
    # freeze() before converting, exactly as mlx_lm.lora's train_model does. Without it
    # every unquantised tensor (the 161 norm weights) is still trainable and lands in the
    # adapter file. Harmless to fuse - they are written back unchanged - but it makes a
    # 25 MB "adapter" that is mostly not an adapter, and it would hide a real difference
    # if one of those tensors ever were modified.
    model.freeze()
    linear_to_lora_layers(model, NUM_LAYERS, LORA_PARAMETERS)

    adapter_weights = dict(tree_flatten(model.trainable_parameters()))
    b_names = [name for name in adapter_weights if name.endswith("lora_b")]
    assert b_names, "no lora_b tensors found - the LoRA layers were not applied"
    unexpected = [n for n in adapter_weights if not n.endswith(("lora_a", "lora_b"))]
    assert not unexpected, f"adapter carries non-LoRA tensors: {unexpected[:3]}"
    for name in b_names:
        # The whole argument rests on this being exactly zero, so assert it rather than
        # trusting the initialiser to keep behaving this way across mlx-lm versions.
        assert mx.all(adapter_weights[name] == 0).item(), f"{name} is not zero-initialised"

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    mx.save_safetensors(str(out / "adapters.safetensors"), adapter_weights)
    (out / "adapter_config.json").write_text(json.dumps({
        "fine_tune_type": "lora",
        "num_layers": NUM_LAYERS,
        "lora_parameters": LORA_PARAMETERS,
    }, indent=2) + "\n")

    print(f"  {len(adapter_weights)} adapter tensor(s), {len(b_names)} lora_b all zero")
    print(f"  wrote {out}/adapters.safetensors and adapter_config.json")


if __name__ == "__main__":
    main()
