#!/usr/bin/env bash
# Add more tokenized stocks to the EXISTING Arc Testnet deployment (reuses hook, issuer, routers, oracle).
#   server/scripts/add-stocks-arc.sh fork [TICKERS]   rehearse on a local fork of Arc Testnet; writes deployments/arc-fork.json
#   server/scripts/add-stocks-arc.sh real [TICKERS]   REAL broadcast to Arc Testnet; updates deployments/arc-testnet.json
# TICKERS defaults to NVDA,AAPL,GOOGL,META (needs a sigma in deployments/seed.json and a Yahoo quote).
# Key: contracts/.env DEPLOYER_PRIVATE_KEY only (must be the hook + issuer owner). Never printed, never written to a manifest.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-}"; [ "$MODE" = fork ] || [ "$MODE" = real ] || { echo "usage: $0 fork|real [TICKERS]"; exit 2; }
export TICKERS="${2:-NVDA,AAPL,GOOGL,META}"
# The free public RPCs rate-limit (HTTP 429). Pick the first official endpoint that answers a short burst, and retry every preflight read.
retry() { local out i; for i in 1 2 3 4 5 6; do out="$("$@" 2>/dev/null)" && [ -n "$out" ] && { echo "$out"; return 0; }; sleep $((i * 2)); done; return 1; }
healthy() { local u="$1" i; for i in 1 2 3 4 5; do [ "$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST "$u" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}')" = 200 ] || return 1; done; }
pick_rpc() { local u; for u in "${ARC_RPC_URL:-}" https://rpc.testnet.arc.io https://rpc.drpc.testnet.arc.io https://rpc.quicknode.testnet.arc.io https://rpc.blockdaemon.testnet.arc.io https://rpc.testnet.arc.network; do [ -n "$u" ] && healthy "$u" && { echo "$u"; return 0; }; done; return 1; }
ARC_RPC="$(pick_rpc)" || { echo "no healthy Arc RPC right now (all rate-limited or down); try again in a minute"; exit 1; }
echo "using RPC $ARC_RPC"
[ -f "$ROOT/contracts/.env" ] || { echo "missing contracts/.env"; exit 1; }
set -a; . "$ROOT/contracts/.env"; set +a
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is empty}"
BASE="$ROOT/deployments/arc-testnet.json"; [ -f "$BASE" ] || { echo "missing $BASE (deploy first)"; exit 1; }
DEPLOYER="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"

FORK_PID=""; cleanup() { [ -n "$FORK_PID" ] && kill "$FORK_PID" 2>/dev/null || true; }; trap cleanup EXIT
if [ "$MODE" = fork ]; then
  FORK_PORT="${FORK_PORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')}"
  RPC="http://127.0.0.1:${FORK_PORT}"; OUT="$ROOT/deployments/arc-fork.json"
  anvil --fork-url "$ARC_RPC" --port "$FORK_PORT" --silent > "$ROOT/deployments/.arc-fork-stocks.log" 2>&1 & FORK_PID=$!
  for _ in $(seq 1 60); do [ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)" = 5042002 ] && break; sleep 1; done
  # DRY RUN ONLY: anvil lacks Arc's USDC precompiles, so a plain 6-decimal ERC-20 stands in for USDC with the deployer's real balance
  BALUSDC="$(retry cast call 0x3600000000000000000000000000000000000000 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC" | cut -d' ' -f1)"
  CODE="$(python3 -c "import json;print(json.load(open('$ROOT/contracts/out/MockUSDC.sol/MockUSDC.json'))['deployedBytecode']['object'])")"
  cast rpc anvil_setCode 0x3600000000000000000000000000000000000000 "$CODE" --rpc-url "$RPC" >/dev/null
  SLOT="$(cast keccak "$(cast abi-encode 'f(address,uint256)' "$DEPLOYER" 0)")"
  cast rpc anvil_setStorageAt 0x3600000000000000000000000000000000000000 "$SLOT" "$(cast to-uint256 "$BALUSDC")" --rpc-url "$RPC" >/dev/null
else
  RPC="$ARC_RPC"; OUT="$BASE"
fi
[ "$(retry cast chain-id --rpc-url "$RPC")" = 5042002 ] || { echo "refusing: chain id is not 5042002 (or the RPC did not answer)"; exit 1; }
J() { python3 -c "import json,sys;m=json.load(open('$BASE'));print($1)"; }
export HOOK="$(J "m['hook']")" ISSUER="$(J "m['issuer']")" ORACLE="$(J "m['oracle']")" LIQ_ROUTER="$(J "m['liquidityRouter']")"
echo "mode=$MODE deployer=$DEPLOYER USDC=$(retry cast balance "$DEPLOYER" --rpc-url "$RPC" --ether)  tickers=$TICKERS"
OWNER="$(retry cast call "$HOOK" 'owner()(address)' --rpc-url "$RPC")" || { echo "could not read the hook owner (RPC rate limited); nothing was sent, try again"; exit 1; }
[ "$OWNER" = "$DEPLOYER" ] || { echo "deployer does not own the hook (owner is $OWNER)"; exit 1; }

IFS=',' read -ra SY <<< "$TICKERS"
for s in "${SY[@]}"; do
  px="$(curl -s -m 15 -A 'Mozilla/5.0' "https://query1.finance.yahoo.com/v8/finance/chart/$s?interval=5m&range=1d" | python3 -c 'import sys,json;print(round(json.load(sys.stdin)["chart"]["result"][0]["meta"]["regularMarketPrice"]*1e8))')"
  sg="$(python3 -c "import json;print(json.load(open('$ROOT/deployments/seed.json'))['tickers']['$s']['sigmaE12'])")"
  export "PRICE_E8_$s=$px" "SIGMA_E12_$s=$sg"; echo "  $s priceE8=$px sigmaE12=$sg"
done

export INFO="$ROOT/deployments/.add-stocks-$MODE.info.json"
export RPC SENDER="$DEPLOYER" BASE_MANIFEST="$BASE" OUT_MANIFEST="$OUT"
echo "== 1/3 tokens, listing, pools (cast send, resumable)"; python3 "$ROOT/server/scripts/arc_add_stocks.py" create
echo "== 2/3 mint + liquidity (oracle temporarily handed to the deployer, then restored)"; python3 "$ROOT/server/scripts/arc_add_stocks.py" seed
echo "== 3/3 manifest"; python3 "$ROOT/server/scripts/arc_add_stocks.py" merge
echo "final USDC: $(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether)"
