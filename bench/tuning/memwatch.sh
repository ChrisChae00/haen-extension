#!/usr/bin/env bash
# Sample memory pressure and swap while a training run is in flight.
#
# Run 1 recorded MLX's own peak (15.617 GB of 24) but nothing about what the OS was doing to
# stay under it. Peak resident memory can look comfortable while the machine pays for it in
# swap, which costs SSD writes and training speed and does not appear in any field the run
# already logs. By the time it matters the machine has rebooted and the counters are gone -
# swap usage is only knowable while the job is running, so sample it then or not at all.
#
# Usage: tuning/memwatch.sh <logfile> [interval_seconds]
set -euo pipefail
log="${1:?usage: memwatch.sh <logfile> [interval]}"
interval="${2:-30}"

# Swapins/Swapouts are cumulative since boot, so the meaningful figure is the delta across the
# run rather than the absolute count.
baseline=$(vm_stat | awk '/Swapouts/ {gsub(/\./,"",$NF); print $NF}')
echo "# started $(date -u +%FT%TZ)  interval ${interval}s  baseline_swapouts=${baseline}" > "$log"
echo "# iso_time  swap_used_mb  swap_total_mb  free_pct  swapouts_since_boot  swapouts_delta" >> "$log"

while true; do
  usage=$(sysctl -n vm.swapusage)
  used=$(echo "$usage"  | sed -n 's/.*used = \([0-9.]*\)M.*/\1/p')
  total=$(echo "$usage" | sed -n 's/.*total = \([0-9.]*\)M.*/\1/p')
  free_pct=$(memory_pressure 2>/dev/null | sed -n 's/.*free percentage: *\([0-9]*\)%.*/\1/p' | tail -1)
  now=$(vm_stat | awk '/Swapouts/ {gsub(/\./,"",$NF); print $NF}')
  printf '%s  %s  %s  %s  %s  %s\n' "$(date -u +%FT%TZ)" "${used:-?}" "${total:-?}" "${free_pct:-?}" "$now" "$((now - baseline))" >> "$log"
  sleep "$interval"
done
