#!/usr/bin/env bash
# Push a reference price into the local RefPriceOracle through the MockForwarder (what the CRE workflow does for real).
#   server/scripts/push-price.sh NVDA 189.50            session open, fresh
#   server/scripts/push-price.sh NVDA 189.50 closed     session closed (US market shut: weekend / holiday / night)
#   server/scripts/push-price.sh NVDA 189.50 open 120   report observed 120 s ago (ages the reference)
# Local anvil only. Uses anvil account 0 (public key); MockForwarder.deliver is open to anyone.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
M="$ROOT/deployments/local.json"
SYM="${1:?usage: push-price.sh TICKER PRICE_USD [open|closed] [age_seconds]}"
PRICE="${2:?price in USD, e.g. 189.50}"
STATE="${3:-open}"
AGE="${4:-0}"
RPC="$(python3 -c "import json;print(json.load(open('$M'))['rpc'])")"
FWD="$(python3 -c "import json;print(json.load(open('$M'))['forwarder'])")"
ORC="$(python3 -c "import json;print(json.load(open('$M'))['oracle'])")"
FEED="$(cast format-bytes32-string "$SYM")"
PRICE_E8="$(python3 -c "print(int(round(float('$PRICE')*1e8)))")"
case "$STATE" in open) OPEN=true;; closed) OPEN=false;; *) echo "state must be open|closed"; exit 1;; esac
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil account 0, public

# the oracle ignores reports that are not newer than the stored one, so make asOf strictly increasing
PREV="$(cast call "$ORC" "priceOf(bytes32)(uint64,uint64,bool)" "$FEED" --rpc-url "$RPC" | sed -n 2p | awk '{print $1}')"
while :; do
  ASOF=$(( $(date +%s) - AGE - 1 ))
  [ "$ASOF" -gt "${PREV:-0}" ] && break
  sleep 1
done
REPORT="$(cast abi-encode "f(bytes32,uint64,bool,uint64)" "$FEED" "$PRICE_E8" "$OPEN" "$ASOF")"
cast send "$FWD" "deliver(address,bytes)" "$ORC" "$REPORT" --private-key "$KEY" --rpc-url "$RPC" >/dev/null
echo "pushed $SYM = $PRICE ($STATE, asOf=$ASOF)"
