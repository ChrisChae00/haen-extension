#!/usr/bin/env bash
# Run a training config with memory sampling attached.
#
# Run 1 logged MLX's own peak (15.617 GB of 24) and nothing about what the OS did to stay
# under it. Swap is only observable while the job runs - the counters reset at boot, and by
# the time anyone asks, the machine has rebooted. Sampling it is therefore not optional
# instrumentation to add if someone remembers; it is part of starting a run, so it lives here
# rather than in a habit.
#
# Usage: tuning/train.sh <config.yaml> [memwatch_interval_seconds]
set -uo pipefail

# Resolve the config against the caller's directory before moving: this script cd's into its
# own directory so mlx_lm's relative `data:` path works, which silently breaks any relative
# config path the caller passed.
config_arg="${1:?usage: train.sh <config.yaml> [interval]}"
case "$config_arg" in
  /*) config="$config_arg" ;;
  *)  config="$PWD/$config_arg" ;;
esac
[ -f "$config" ] || { echo "no such config: $config_arg"; exit 1; }

cd "$(dirname "$0")"
interval="${2:-30}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
train_log="train-${stamp}.log"
mem_log="memory-${stamp}.log"

./memwatch.sh "$mem_log" "$interval" &
watcher=$!
trap 'kill "$watcher" 2>/dev/null || true' EXIT

echo "  config     $config"
echo "  train log  tuning/$train_log"
echo "  memory log tuning/$mem_log"
# Deliberately not under `set -e`: when training fails is exactly when the memory log matters,
# and aborting here would skip the summary below.
../../.venv-mlx/bin/python -m mlx_lm lora -c "$config" > "$train_log" 2>&1
status=$?
[ "$status" -eq 0 ] || echo "  !! training exited $status - see tuning/$train_log"

kill "$watcher" 2>/dev/null || true
trap - EXIT

# Summarise rather than leave it to be read later, because "we sampled it" and "we looked at
# it" are different claims and only the second one catches anything.
awk 'NR>2{
  if(n==0){mnu=$2;mxu=$2;mnf=$4}
  n++
  if($2<mnu)mnu=$2; if($2>mxu)mxu=$2; if($4<mnf)mnf=$4; if($6>mxd)mxd=$6
} END{
  if(n==0){print "  no memory samples recorded"; exit}
  printf "  memory: %d samples | swap used %s -> %s MB | free pct min %s | new swapouts %d\n", n, mnu, mxu, mnf, mxd
  if(mxd>0) print "  !! the run caused swapouts - training was paying for memory in SSD writes"
}' "$mem_log"
grep -a "Peak mem" "$train_log" | tail -1 | sed 's/^/  /'

exit $status
