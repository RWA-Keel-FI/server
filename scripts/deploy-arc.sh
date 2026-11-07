#!/usr/bin/env bash
# Deploy + seed + showcase the DeviationFee system on Arc Testnet (chain 5042002), or on a local fork of it.
#   server/scripts/deploy-arc.sh fork    dry run on anvil --fork-url <arc rpc> (port ${FORK_PORT:-8547}); writes deployments/arc-fork.json
#   server/scripts/deploy-arc.sh real    REAL broadcast to Arc Testnet; writes deployments/arc-testnet.json
# Key: contracts/.env DEPLOYER_PRIVATE_KEY only. Never printed, never written to a manifest.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-}"; [ "$MODE" = fork ] || [ "$MODE" = real ] || { echo "usage: $0 fork|real"; exit 2; }
ARC_RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
[ -f "$ROOT/contracts/.env" ] || { echo "missing contracts/.env (see contracts/.env.example)"; exit 1; }
set -a; . "$ROOT/contracts/.env"; set +a
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is empty}"

DEPLOYER="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"
FORK_PID=""
cleanup() { [ -n "$FORK_PID" ] && kill "$FORK_PID" 2>/dev/null || true; }
trap cleanup EXIT
if [ "$MODE" = fork ]; then
  RPC="http://127.0.0.1:${FORK_PORT:-8547}"
  anvil --fork-url "$ARC_RPC" --port ${FORK_PORT:-8547} --silent > "$ROOT/deployments/.arc-fork.log" 2>&1 &
  FORK_PID=$!
  for _ in $(seq 1 60); do [ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)" = 5042002 ] && break; sleep 1; done
  # DRY RUN ONLY. Arc's USDC ERC-20 moves balances via chain precompiles that anvil does not have, so on the fork we put a
  # plain 6-decimal ERC-20 (MockUSDC runtime code) at the USDC address and give the deployer the same 20 USDC. This tests all
  # of OUR contract logic; the real chain's own USDC behaviour is the one thing this dry run cannot cover.
  CODE="$(python3 -c "import json;print(json.load(open('$ROOT/contracts/out/MockUSDC.sol/MockUSDC.json'))['deployedBytecode']['object'])")"
  cast rpc anvil_setCode 0x3600000000000000000000000000000000000000 "$CODE" --rpc-url "$RPC" >/dev/null
  SLOT="$(cast keccak "$(cast abi-encode 'f(address,uint256)' "$DEPLOYER" 0)")"
  cast rpc anvil_setStorageAt 0x3600000000000000000000000000000000000000 "$SLOT" "$(cast to-uint256 20000000)" --rpc-url "$RPC" >/dev/null
  [ "$(cast call 0x3600000000000000000000000000000000000000 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC" | cut -d' ' -f1)" = 20000000 ] || { echo "fork USDC stand-in failed"; exit 1; }
  MANIFEST=arc-fork.json
else
  RPC="$ARC_RPC"; MANIFEST=arc-testnet.json
fi
[ "$(cast chain-id --rpc-url "$RPC")" = 5042002 ] || { echo "refusing: chain id is not 5042002"; exit 1; }
echo "mode=$MODE deployer=$DEPLOYER native(USDC)=$(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether)"

# live TSLA quote (Yahoo chart API) + measured sigma from the backtest seed
export PRICE_E8_TSLA="$(curl -s -A 'Mozilla/5.0' 'https://query1.finance.yahoo.com/v8/finance/chart/TSLA?interval=5m&range=1d' \
  | python3 -c 'import sys,json;print(round(json.load(sys.stdin)["chart"]["result"][0]["meta"]["regularMarketPrice"]*1e8))')"
export SIGMA_E12_TSLA="$(python3 -c "import json;print(json.load(open('$ROOT/deployments/seed.json'))['tickers']['TSLA']['sigmaE12'])")"
echo "TSLA priceE8=$PRICE_E8_TSLA sigmaE12=$SIGMA_E12_TSLA"

cd "$ROOT/contracts"
FS=(forge script --rpc-url "$RPC" --broadcast --slow --legacy -vv)
START_BLOCK="$(cast block-number --rpc-url "$RPC")"
LOG="$ROOT/deployments/.deploy-arc-$MODE.log"
echo "== 1/4 deploy"; "${FS[@]}" script/DeployArc.s.sol:DeployArc 2>&1 | tee "$LOG" | grep -E "Error|revert|ONCHAIN|DEPLOY\||FAIL" || true
grep -q "ONCHAIN EXECUTION COMPLETE" "$LOG" || { echo "deploy failed; see $LOG"; exit 1; }
val() { grep -E "^ *DEPLOY\|$1\|" "$LOG" | head -1 | awk -F'|' '{gsub(/ /,"",$3); print $3}'; }
tval() { grep -E "^ *TICKER\|TSLA\|$1\|" "$LOG" | head -1 | awk -F'|' '{gsub(/ /,"",$4); print $4}'; }
export ORACLE="$(val oracle)" HOOK="$(val hook)" ISSUER="$(val issuer)" SWAP_ROUTER="$(val swapRouter)" LIQ_ROUTER="$(val liquidityRouter)" TOKEN="$(tval token)"

export RPC SENDER="$DEPLOYER" SHOWCASE_NAME="${MANIFEST%.json}"
S="$ROOT/server/scripts/arc_stages.py"
echo "== 2/4 seed (oracle price, mint, liquidity)"; python3 "$S" seed
echo "== 3/4 showcase swaps (normal vs arbitrage)"; python3 "$S" showcase
echo "== 4/4 hand the oracle to the real Chainlink forwarder"; python3 "$S" handover

MANIFEST_NAME="$MANIFEST" EXPLORER="https://explorer.testnet.arc.io" \
MANIFEST_NETWORK="Arc Testnet (chain id 5042002)$([ "$MODE" = fork ] && echo ' [LOCAL FORK DRY RUN, not on chain]'). TEST TOKENS: tTSLA is a mock token, not a real stock." \
  python3 "$ROOT/server/scripts/build_manifest.py" "$LOG" "$([ "$MODE" = fork ] && echo http://127.0.0.1:${FORK_PORT:-8547} || echo "$ARC_RPC")" "$START_BLOCK"
echo "final native(USDC) balance: $(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether)"
echo "done: deployments/$MANIFEST"
