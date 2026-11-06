#!/usr/bin/env bash
# Runs the three scenarios on a fresh anvil + deployment each, writes out/summary-<scenario>.json and out/run-<scenario>.log
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
for spec in "calm 120" "volatile 180" "weekend-gap 262"; do
  set -- $spec
  ./fresh-chain.sh > "out/deploy-$1.log" 2>&1 || { echo "deploy failed for $1"; continue; }
  pnpm sim up --scenario "$1" --venue anvil --ticks "$2" > "out/run-$1.log" 2>&1
  echo "finished $1"
done
echo ALLDONE
