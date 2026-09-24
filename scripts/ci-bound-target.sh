#!/usr/bin/env bash
# Keep a self-hosted runner's persistent cargo target dir under a size cap.
#
# The runners on the M4 Max keep src-tauri/target between builds so only what
# changed recompiles — but cargo never garbage-collects it, and every
# dependency bump or profile change leaves the old artifacts behind. Past the
# cap, wipe it: the next build is a from-scratch one (a few minutes on the M4
# Max), and the disk stays bounded.
#
# usage: ci-bound-target.sh <target-dir> <max-GB>
set -euo pipefail
dir="$1"
max_gb="$2"
[ -d "$dir" ] || exit 0
kb=$(du -sk "$dir" | cut -f1)
gb=$((kb / 1024 / 1024))
if [ "$gb" -ge "$max_gb" ]; then
  echo "$dir is ${gb} GB (cap ${max_gb} GB) — clearing it"
  rm -rf "$dir"
else
  echo "$dir is ${gb} GB (cap ${max_gb} GB) — keeping it"
fi
