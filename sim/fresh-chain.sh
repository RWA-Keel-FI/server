#!/usr/bin/env bash
# Restart a LOCAL anvil (port 8545 only) and redeploy the demo with ../scripts/deploy-local.sh.
# Only touches an anvil on 127.0.0.1:8545 that reports chain id 31337.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RPC=http://127.0.0.1:8545
if [ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)" = "31337" ]; then
  pkill -f "anvil --port 8545" 2>/dev/null || true
  for _ in $(seq 1 20); do [ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)" = "31337" ] || break; sleep 0.5; done
fi
mkdir -p "$HERE/out"
setsid nohup anvil --port 8545 --silent > "$HERE/out/anvil.log" 2>&1 &
for _ in $(seq 1 40); do [ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)" = "31337" ] && break; sleep 0.5; done
rm -f "$HERE/../../deployments/local.json"
"$HERE/../scripts/deploy-local.sh" | tail -3
