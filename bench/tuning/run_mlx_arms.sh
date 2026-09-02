#!/usr/bin/env bash
# Run both arms of the LoRA comparison through mlx_lm.server, unfused.
#
# Fusing a rank-8 adapter into the int4 checkpoint loses the training (see README.md), so
# both arms are served with the adapter applied at inference instead. That makes the two
# arms indistinguishable from their configs alone -- mlx_lm.server names the model by its
# base path, so `modelId` is identical and the only difference is which server is running.
# This script is the guard: it starts the server each config asks for and refuses to run if
# the live process does not match, so mislabelling an arm takes a code change, not a slip.
#
# Checking the command line is not enough on its own. mlx_lm.server accepts --adapter-path
# and then ignores it (see mlx_server_adapter.py), which produced two "different" arms whose
# 40 outputs were byte-identical in all four scored fields. So the adapter arm goes through
# mlx_server_adapter.py --verify-adapter, which generates with and without the adapter and
# refuses to start unless they differ. Intent is checked below; effect is checked there.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8080
MODEL=mlx-community/Qwen3-14B-4bit
PY=../.venv-mlx/bin/python

# Which arms to run. Pass configs as arguments to run a subset -- the control arm is a
# property of the base model, not of any adapter, so once it has been measured a later
# candidate only needs its own arm:
#   bash tuning/run_mlx_arms.sh configs/qwen3-14b-tuned-run2-mlx.json
configs=("$@")
if [ ${#configs[@]} -eq 0 ]; then
  configs=(configs/qwen3-14b-control-mlx.json configs/qwen3-14b-tuned-run1-mlx.json)
fi

for config in "${configs[@]}"; do
  adapter=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('adapterPath') or '')" "$config")
  name=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['name'])" "$config")
  echo "=== $name (adapter: ${adapter:-none}) ==="

  pkill -f "mlx_server_adapter" 2>/dev/null || true
  sleep 3
  if [ -n "$adapter" ]; then
    "$PY" tuning/mlx_server_adapter.py --model "$MODEL" --adapter-path "$adapter" \
      --port "$PORT" --verify-adapter > "/tmp/mlx-server-$name.log" 2>&1 &
  else
    "$PY" tuning/mlx_server_adapter.py --model "$MODEL" --port "$PORT" > "/tmp/mlx-server-$name.log" 2>&1 &
  fi

  # --verify-adapter loads the model twice before serving, so allow a long startup.
  for _ in $(seq 1 120); do
    curl -s -m 2 "http://localhost:$PORT/v1/models" >/dev/null 2>&1 && break
    sleep 5
  done
  curl -s -m 5 "http://localhost:$PORT/v1/models" >/dev/null || {
    echo "server never came up:"; tail -5 "/tmp/mlx-server-$name.log"; exit 1; }
  if [ -n "$adapter" ]; then
    grep -q "adapter verified" "/tmp/mlx-server-$name.log" || { echo "adapter was not verified"; exit 1; }
  fi

  # The assertion this script exists for: the live command line must carry the adapter the
  # config names, and must not carry one when the config names none.
  # `pgrep -a` is Linux-only; on macOS it yields a bare PID, which silently satisfies the
  # "must not contain --adapter-path" branch and makes the control's check vacuous. Read the
  # command line with ps instead.
  live=$(ps -o command= -p "$(pgrep -f 'mlx_server_adapter' | head -1)")
  if [ -n "$adapter" ]; then
    case "$live" in *"--adapter-path $adapter"*) ;; *) echo "server is not serving $adapter: $live"; exit 1;; esac
  else
    case "$live" in *--adapter-path*) echo "server has an adapter but config asks for none: $live"; exit 1;; *) ;; esac
  fi
  echo "  server verified: $live"

  node src/run.js --config "$config"
done

pkill -f "mlx_server_adapter" 2>/dev/null || true
echo "=== both arms done; server stopped ==="
