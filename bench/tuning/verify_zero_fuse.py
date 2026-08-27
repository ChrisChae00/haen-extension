"""Prove the untuned control is untuned, and measure what the fuse round trip cost.

`make_zero_adapter.py` argues the fused model is mathematically the base model because
`lora_b` is zero. That is an argument about source code. This is the measurement: load
every tensor from both checkpoints and compare them.

The expected result is not "bit-identical". `LoRALinear.fuse()` dequantises the int4
weight, adds the (zero) delta, and re-quantises, so the packed weights can differ by
rounding even though nothing was learned. Reporting that number is the point - it is the
noise floor of the serving pipeline, and any later tuned-vs-control delta has to clear it
to mean anything.
"""

import argparse
import json
from pathlib import Path

import mlx.core as mx
from huggingface_hub import snapshot_download


def load_all(path):
    weights = {}
    for shard in sorted(Path(path).glob("*.safetensors")):
        weights.update(mx.load(str(shard)))
    return weights


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="mlx-community/Qwen3-14B-4bit")
    parser.add_argument("--fused", default="bench/tuning/fused-untuned-control")
    args = parser.parse_args()

    base_path = args.base
    if not Path(base_path).exists():
        base_path = snapshot_download(repo_id=args.base)

    base = load_all(base_path)
    fused = load_all(args.fused)

    only_base = sorted(set(base) - set(fused))
    only_fused = sorted(set(fused) - set(base))
    if only_base or only_fused:
        print(f"  !! tensor sets differ: {len(only_base)} only in base, {len(only_fused)} only in fused")
        print(f"     base-only  : {only_base[:3]}")
        print(f"     fused-only : {only_fused[:3]}")

    config = json.loads((Path(args.fused) / "config.json").read_text())
    quant = config.get("quantization") or {}
    group_size, bits = quant.get("group_size", 64), quant.get("bits", 4)

    shared = set(base) & set(fused)
    # An int4 weight is stored packed in uint32 alongside its scales and biases, so
    # comparing the raw tensors reports differences in the thousands-of-millions that mean
    # nothing. Dequantise each triple and compare the values the model actually multiplies.
    quantized = sorted(n[: -len(".weight")] for n in shared
                       if n.endswith(".weight") and f"{n[:-len('.weight')]}.scales" in shared)
    plain = sorted(n for n in shared
                   if not any(n == f"{q}.{suffix}" for q in quantized
                              for suffix in ("weight", "scales", "biases")))

    identical, differing = 0, []
    for name in plain:
        a, b = base[name], fused[name]
        if a.shape != b.shape or a.dtype != b.dtype:
            differing.append((name, None))
        elif mx.array_equal(a, b).item():
            identical += 1
        else:
            differing.append((name, mx.max(mx.abs(a.astype(mx.float32) - b.astype(mx.float32))).item()))

    packed_identical, dequant_deltas = 0, []
    for prefix in quantized:
        same = all(mx.array_equal(base[f"{prefix}.{s}"], fused[f"{prefix}.{s}"]).item()
                   for s in ("weight", "scales", "biases"))
        if same:
            packed_identical += 1
            continue
        values = []
        for source in (base, fused):
            values.append(mx.dequantize(
                source[f"{prefix}.weight"], source[f"{prefix}.scales"],
                source[f"{prefix}.biases"], group_size=group_size, bits=bits, mode="affine",
            ).astype(mx.float32))
        diff = mx.abs(values[0] - values[1])
        scale = mx.max(mx.abs(values[0])).item()
        dequant_deltas.append((prefix, mx.max(diff).item(), mx.mean(diff).item(), scale))

    print(f"  {len(plain)} unquantised tensor(s): {identical} bit-identical, {len(differing)} differ")
    for name, delta in differing[:5]:
        print(f"    max |diff| {delta}  {name}")
    print(f"  {len(quantized)} quantised layer(s): {packed_identical} untouched, "
          f"{len(dequant_deltas)} re-quantised by the fuse")
    if dequant_deltas:
        worst = max(dequant_deltas, key=lambda row: row[1])
        mean_of_means = sum(row[2] for row in dequant_deltas) / len(dequant_deltas)
        print(f"    worst max |diff| {worst[1]:.6g} on {worst[0]} "
              f"(that layer's largest weight is {worst[3]:.6g})")
        print(f"    mean |diff| across re-quantised layers: {mean_of_means:.6g}")
        if worst[1] == 0.0:
            print("    -> the round trip is exactly lossless; the control is the base model bit for bit")

    for key in ("quantization", "quantization_config"):
        block = config.get(key)
        mode = block.get("mode") if isinstance(block, dict) else None
        print(f"  config.{key}.mode = {mode!r}"
              + ("" if mode == "affine" else "   <- Ollama import needs 'affine' here"))


if __name__ == "__main__":
    main()
