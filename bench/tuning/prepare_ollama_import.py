"""Make an MLX fused checkpoint importable by Ollama's experimental Safetensors path.

MLX writes `{"group_size": 64, "bits": 4}` and lets `mode` default to affine. Ollama's
importer does not apply that default: with `mode` absent it misreads the checkpoint as a
1.8B bfloat16 model and the runner panics. Two of the three spike tags in this project
were exactly that failure, and `ollama show` reported them as 1.8B/bfloat16 rather than
erroring, so the only symptom is a model that is quietly the wrong thing.

Both `quantization` and `quantization_config` need it - the importer reads one, the
model loader reads the other.

Applies to the tuned candidate's fuse as well as the untuned control's; same step, same
script.
"""

import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fused_dir")
    parser.add_argument("--mode", default="affine")
    args = parser.parse_args()

    config_file = Path(args.fused_dir) / "config.json"
    config = json.loads(config_file.read_text())

    changed = []
    for key in ("quantization", "quantization_config"):
        block = config.get(key)
        if not isinstance(block, dict):
            raise SystemExit(f"{config_file}: no {key} block - is this a quantised checkpoint?")
        if block.get("mode") == args.mode:
            continue
        block["mode"] = args.mode
        changed.append(key)

    if not changed:
        print(f"  {config_file}: both blocks already mode={args.mode!r}")
        return

    config_file.write_text(json.dumps(config, indent=2) + "\n")
    print(f"  {config_file}: set mode={args.mode!r} on {', '.join(changed)}")
    print("  Verify after `ollama create`: `ollama show <tag>` must report 14.8B / int4.")


if __name__ == "__main__":
    main()
