#!/usr/bin/env bash
# End-to-end smoke test against the local deployment (deploy first: server/scripts/deploy-local.sh).
# Checks: price push, swaps in hook + control pools, FeeSet event, issuer mint open/closed, fail-open when closed.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
M="$ROOT/deployments/local.json"
export M
RPC="$(python3 -c "import json;print(json.load(open('$M'))['rpc'])")"
FAIL=0
ok()  { echo "  PASS  $*"; }
bad() { echo "  FAIL  $*"; FAIL=1; }
j()   { python3 -c "import json,sys;m=json.load(open('$M'));print(eval(sys.argv[1]))" "$1"; }

RETAIL_KEY=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba   # anvil #5 (public)
RETAIL="$(j "m['accounts']['retail']")"
SR="$(j "m['swapRouter']")"; ISS="$(j "m['issuer']")"; HOOK="$(j "m['hook']")"; PM="$(j "m['poolManager']")"
SYM=NVDA
FEED="$(j "m['tickers']['$SYM']['feedId']")"
START="$(j "m['tickers']['$SYM']['startPriceE8']/1e8")"
STOCK_C0="$(j "m['tickers']['$SYM']['stockIsCurrency0']")"
keyof() { j "'(%s,%s,%d,%d,%s)' % tuple(m['tickers']['$SYM']['$1']['key'][k] for k in ('currency0','currency1','fee','tickSpacing','hooks'))"; }
HK="$(keyof hookPool)"; CK="$(keyof controlPool)"
# paying USDC for stock: zeroForOne = !stockIsCurrency0 ; paying stock for USDC: zeroForOne = stockIsCurrency0
if [ "$STOCK_C0" = "True" ]; then BUY_ZFO=false; SELL_ZFO=true; else BUY_ZFO=true; SELL_ZFO=false; fi

# swap <key> <zeroForOne> <amountIn>  -> prints receipt json path
swap() {
  local out; out="$(cast send "$SR" "swapExactIn((address,address,uint24,int24,address),bool,uint256,uint256)(uint256)" "$1" "$2" "$3" 0 \
    --private-key "$RETAIL_KEY" --rpc-url "$RPC" --json 2>&1)" || { echo "SWAPFAIL $out"; return 1; }
  echo "$out"
}
# fees <receipt-json>  -> "feeSetFee f0 devBps armed pmFee"  (hook FeeSet + PoolManager Swap); NA when an event is absent
fees() {
  RECEIPT="$1" HOOK="$HOOK" PM="$PM" python3 -c '
import json, os, subprocess
hook, pm = os.environ["HOOK"].lower(), os.environ["PM"].lower()
r = json.loads(os.environ["RECEIPT"])
k = lambda sig: subprocess.run(["cast", "keccak", sig], capture_output=True, text=True).stdout.strip()
t_fs, t_sw = k("FeeSet(bytes32,uint24,uint24,uint32,bool)"), k("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")
fs = sw = None
for l in r["logs"]:
    d = l["data"][2:]
    w = [int(d[i:i+64], 16) for i in range(0, len(d), 64)]
    if l["address"].lower() == hook and l["topics"][0] == t_fs: fs = w
    if l["address"].lower() == pm and l["topics"][0] == t_sw: sw = w
print(*(fs[:4] if fs else ["NA"] * 4), sw[5] if sw else "NA")
'
}

echo "== 1. reference price +1% above the pool (pool below reference => buying stock is the arbitrage direction)"
REF="$(python3 -c "print(round($START*1.01,2))")"
"$ROOT/server/scripts/push-price.sh" $SYM "$REF" open 0 || bad "price push failed"
echo "== 2. hook pool: swap in the ARBITRAGE direction (pay USDC, buy stock)"
R="$(swap "$HK" $BUY_ZFO 1000000000)" || { bad "$R"; }
read -r F F0 DEV ARMED PMF <<<"$(fees "$R")"
echo "     FeeSet: fee=$F pips f0=$F0 d_eff=${DEV}bps armed=$ARMED | PoolManager Swap fee=$PMF"
[ -n "$F" ] && [ "$F" != "NA" ] && ok "hook emitted FeeSet" || bad "no FeeSet event from hook"
[ "$ARMED" = "1" ] && [ "$F" -gt 3000 ] 2>/dev/null && ok "arbitrage-direction swap surcharged (fee $F > 3000)" || bad "arbitrage swap was not surcharged"
[ "$F" = "$PMF" ] && ok "FeeSet.fee equals the fee the PoolManager charged" || bad "FeeSet.fee != PoolManager fee"

echo "== 3. hook pool: swap in the NON-arbitrage direction (sell stock for USDC)"
SELL_AMT=$(python3 -c "print(5*10**18)")
R="$(swap "$HK" $SELL_ZFO $SELL_AMT)" || { bad "$R"; }
read -r F F0 DEV ARMED PMF <<<"$(fees "$R")"
echo "     FeeSet: fee=$F f0=$F0 d_eff=${DEV}bps armed=$ARMED | PoolManager Swap fee=$PMF"
[ "$F" = "3000" ] && [ "$ARMED" = "0" ] && ok "non-arbitrage swap pays the base fee 3000" || bad "non-arbitrage swap fee was $F armed=$ARMED"

echo "== 4. control pool (static 30 bps, no hook): same arbitrage-direction swap"
R="$(swap "$CK" $BUY_ZFO 1000000000)" || { bad "$R"; }
read -r F F0 DEV ARMED PMF <<<"$(fees "$R")"
echo "     FeeSet: $F (none expected) | PoolManager Swap fee=$PMF"
[ "$PMF" = "3000" ] && [ "$F" = "NA" ] && ok "control pool charges a flat 3000 and emits no FeeSet" || bad "control pool fee was $PMF"

echo "== 5. issuer (primary market) while the US session is OPEN: mint \$100 of t$SYM"
cast send "$ISS" "mint(bytes32,uint256)(uint256)" "$FEED" 100000000 --private-key "$RETAIL_KEY" --rpc-url "$RPC" >/dev/null 2>&1 \
  && ok "mint succeeded while the session is open" || bad "mint reverted while open"

echo "== 6. session CLOSED (weekend): push a closed report"
"$ROOT/server/scripts/push-price.sh" $SYM "$REF" closed 0 || bad "closed push failed"
OUT="$(cast send "$ISS" "mint(bytes32,uint256)(uint256)" "$FEED" 100000000 --private-key "$RETAIL_KEY" --rpc-url "$RPC" 2>&1)"
if echo "$OUT" | grep -qi "revert\|PrimaryMarketClosed\|failed"; then ok "issuer mint reverts while the session is closed"; else bad "issuer mint did NOT revert while closed"; fi
echo "     primaryMarketOpen = $(cast call "$ISS" "primaryMarketOpen(bytes32)(bool)" "$FEED" --rpc-url "$RPC")"
echo "== 7. secondary pool keeps trading while closed, hook fails open to the base fee"
R="$(swap "$HK" $BUY_ZFO 1000000000)" || { bad "$R"; }
read -r F F0 DEV ARMED PMF <<<"$(fees "$R")"
echo "     FeeSet: fee=$F f0=$F0 armed=$ARMED"
[ "$F" = "3000" ] && [ "$ARMED" = "0" ] && ok "pool still trades and charges the base fee while closed" || bad "closed-session fee was $F armed=$ARMED"

echo
[ "$FAIL" = "0" ] && echo "SMOKE TEST: ALL PASSED" || echo "SMOKE TEST: FAILURES (see above)"
exit "$FAIL"
