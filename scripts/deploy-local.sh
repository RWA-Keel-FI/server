#!/usr/bin/env bash
# Deploy the whole DeviationFee demo to a LOCAL anvil (chain id 31337) and write deployments/local.json.
#   server/scripts/deploy-local.sh     deploy (starts anvil if none is running; no-op if already deployed)
#   server/scripts/deploy-local.sh --restart  kill the anvil this script started, start a fresh one, deploy
# Env: RPC_URL (default http://127.0.0.1:8545)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RPC="${RPC_URL:-http://127.0.0.1:8545}"
PORT="${RPC##*:}"; PORT="${PORT%%/*}"
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266   # anvil account 0 (public)
PID_FILE="$ROOT/deployments/.anvil.pid"
LOG="$ROOT/deployments/.deploy.log"

case "$RPC" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing: RPC_URL must be a local anvil (got $RPC)"; exit 1;; esac
for b in anvil forge cast python3; do command -v "$b" >/dev/null || { echo "missing tool: $b"; exit 1; }; done

up() { [ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)" = "31337" ]; }

if [ "${1:-}" = "--restart" ]; then
  [ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null || true
  rm -f "$PID_FILE" "$ROOT/deployments/local.json"
  for _ in $(seq 1 20); do up || break; sleep 0.5; done
  if up; then echo "an anvil you started yourself is still on $RPC; stop it and rerun"; exit 1; fi
fi

if ! up; then
  echo "starting anvil on port $PORT ..."
  nohup anvil --port "$PORT" --silent > "$ROOT/deployments/.anvil.log" 2>&1 &
  echo $! > "$PID_FILE"
  for _ in $(seq 1 40); do up && break; sleep 0.5; done
  up || { echo "anvil did not come up; see deployments/.anvil.log"; exit 1; }
fi

NONCE="$(cast nonce "$DEPLOYER" --rpc-url "$RPC")"
if [ "$NONCE" != "0" ]; then
  HOOK="$(python3 -c "import json;print(json.load(open('$ROOT/deployments/local.json'))['hook'])" 2>/dev/null || true)"
  if [ -n "$HOOK" ] && [ "$(cast code "$HOOK" --rpc-url "$RPC")" != "0x" ]; then
    echo "already deployed (hook $HOOK). Use --restart for a fresh chain."; exit 0
  fi
  echo "this anvil already has transactions but no matching deployments/local.json. Run: server/scripts/deploy-local.sh --restart"; exit 1
fi

# env for the Solidity script, from deployments/seed.json
eval "$(python3 - "$ROOT/deployments/seed.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
print('export TICKERS=' + ",".join(s["tickers"]))
for t, v in s["tickers"].items():
    print(f'export PRICE_E8_{t}={v["startPriceE8"]}')
    print(f'export SIGMA_E12_{t}={v["sigmaE12"]}')
PY
)"

START_BLOCK="$(cast block-number --rpc-url "$RPC")"
echo "deploying (forge script) ..."
( cd "$ROOT/contracts" && forge script script/DeployLocal.s.sol --rpc-url "$RPC" --broadcast --slow -vv ) 2>&1 | tee "$LOG" | grep -E "Error|error|revert|Script ran|ONCHAIN|FAIL" || true
grep -q "ONCHAIN EXECUTION COMPLETE" "$LOG" || { echo "deploy failed; see $LOG"; exit 1; }
python3 "$ROOT/server/scripts/build_manifest.py" "$LOG" "$RPC" "$START_BLOCK"
echo "done: $ROOT/deployments/local.json"
