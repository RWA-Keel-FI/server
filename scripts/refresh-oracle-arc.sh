#!/usr/bin/env bash
# DEMO-TIME oracle refresh on Arc Testnet. The hook ignores a reference older than 15 minutes, so the deviation fee only shows on the
# live pools while the oracle holds a fresh price. CRE normally writes it (US market hours); this writes the current TSLA quote by hand:
#   deployer becomes the oracle's forwarder -> writes the quote -> the real Chainlink forwarder is restored.
# It sends 3 transactions from the deployer in contracts/.env and costs a few cents of gas. Say in the demo that the price was set by hand.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$ROOT/contracts/.env" ] || { echo "missing contracts/.env"; exit 1; }
set -a; . "$ROOT/contracts/.env"; set +a
export RPC="${ARC_RPC_URL:-https://rpc.quicknode.testnet.arc.io}"
[ "$(cast chain-id --rpc-url "$RPC")" = 5042002 ] || { echo "refusing: chain id is not 5042002"; exit 1; }
M="$ROOT/deployments/arc-testnet.json"; [ -f "$M" ] || M="$ROOT/client/deployments/arc-testnet.json"
j() { python3 -c "import json,sys;m=json.load(open('$M'));print(eval(sys.argv[1]))" "$1"; }
export ORACLE="$(j "m['oracle']")" HOOK="$(j "m['hook']")" ISSUER="$(j "m['issuer']")" SWAP_ROUTER="$(j "m['swapRouter']")" LIQ_ROUTER="$(j "m['liquidityRouter']")" TOKEN="$(j "m['tickers']['TSLA']['token']")"
export SENDER="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"
[ "$SENDER" = "$(cast call "$ORACLE" 'owner()(address)' --rpc-url "$RPC")" ] || { echo "the key in contracts/.env is not the oracle owner"; exit 1; }
export PRICE_E8_TSLA="$(curl -s -A 'Mozilla/5.0' 'https://query1.finance.yahoo.com/v8/finance/chart/TSLA?interval=5m&range=1d' | python3 -c 'import sys,json;print(round(json.load(sys.stdin)["chart"]["result"][0]["meta"]["regularMarketPrice"]*1e8))')"
echo "refreshing oracle $ORACLE with TSLA \$$(python3 -c "print($PRICE_E8_TSLA/1e8)")"
python3 "$ROOT/server/scripts/arc_stages.py" refresh
echo "fresh for 15 minutes. forwarder restored: $(cast call "$ORACLE" 'getForwarderAddress()(address)' --rpc-url "$RPC")"
