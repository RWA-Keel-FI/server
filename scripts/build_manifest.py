#!/usr/bin/env python3
"""Turn the DEPLOY|/ACCOUNT|/TICKER|/POOL| lines printed by DeployLocal.s.sol into deployments/local.json and copy ABIs."""
import json, os, re, sys, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))  # project root (deployments/ and contracts/ live there)
log_path, rpc = sys.argv[1], sys.argv[2]
start_block = int(sys.argv[3]) if len(sys.argv) > 3 else 0

dep, acct, tick, pools = {}, {}, {}, {}
for raw in open(log_path, encoding="utf-8", errors="replace"):
    line = raw.strip()
    if not re.match(r"^(DEPLOY|ACCOUNT|TICKER|POOL)\|", line):
        continue
    parts = [p.strip() for p in line.split("|")]
    kind = parts[0]
    if kind in ("DEPLOY", "ACCOUNT"):
        (dep if kind == "DEPLOY" else acct)[parts[1]] = parts[2]
    elif kind == "TICKER":
        tick.setdefault(parts[1], {})[parts[2]] = parts[3]
    elif kind == "POOL":
        pools.setdefault(parts[1], {}).setdefault(parts[2], {})[parts[3]] = parts[4]

need = ["poolManager", "oracle", "hook", "forwarder", "usdc", "issuer", "swapRouter", "liquidityRouter"]
missing = [k for k in need if k not in dep]
if missing or not tick:
    sys.exit(f"build_manifest: deploy log is missing {missing or 'tickers'}; see {log_path}")

def pool_obj(p):
    return {
        "poolId": p["poolId"],
        "key": {
            "currency0": p["currency0"], "currency1": p["currency1"],
            "fee": int(p["fee"]), "tickSpacing": int(p["tickSpacing"]), "hooks": p["hooks"],
        },
    }

tickers = {}
for sym, t in tick.items():
    tickers[sym] = {
        "feedId": t["feedId"],
        "token": t["token"],
        "startPriceE8": int(t["startPriceE8"]),
        "sigmaE12": int(t["sigmaE12"]),
        "stockIsCurrency0": t["stockIsCurrency0"] == "true",
        "hookPool": pool_obj(pools[sym]["hookPool"]),
        "controlPool": pool_obj(pools[sym]["controlPool"]),
    }

manifest = {
    "chainId": int(dep["chainId"]),
    "rpc": rpc,
    "network": "local anvil (chain id 31337). TEST TOKENS ONLY: nothing here is a real stock, a real USDC, or has value.",
    "deployedAt": int(time.time()),
    "startBlock": start_block,
    "poolManager": dep["poolManager"], "oracle": dep["oracle"], "hook": dep["hook"], "forwarder": dep["forwarder"],
    "usdc": dep["usdc"], "issuer": dep["issuer"], "swapRouter": dep["swapRouter"], "liquidityRouter": dep["liquidityRouter"],
    "baseFeePips": 3000,
    "feeSetEvent": "FeeSet(bytes32,uint24,uint24,uint32,bool)",
    "accounts": {
        "deployer": acct["deployer"],
        "lps": [acct["lp1"], acct["lp2"], acct["lp3"]],
        "arb": acct["arb"], "retail": acct["retail"],
        "anvilIndex": {"deployer": 0, "lp1": 1, "lp2": 2, "lp3": 3, "arb": 4, "retail": 5},
        "note": "keys are anvil's public defaults (never use them anywhere else)",
    },
    "lpRanges": {"lp1": "wide (full range)", "lp2": "medium (about +-10%)", "lp3": "tight (about +-2.4%)"},
    "tickers": tickers,
}
out = os.path.join(ROOT, "deployments", "local.json")
json.dump(manifest, open(out, "w"), indent=2)
print("wrote", out)

abi_dir = os.path.join(ROOT, "deployments", "abi")
os.makedirs(abi_dir, exist_ok=True)
names = {"DeviationFeeHook": "DeviationFeeHook.sol", "RefPriceOracle": "RefPriceOracle.sol", "StockIssuer": "StockIssuer.sol",
         "StockToken": "StockToken.sol", "MockUSDC": "MockUSDC.sol", "SwapRouter": "SwapRouter.sol",
         "LiquidityRouter": "LiquidityRouter.sol", "PoolManager": "PoolManager.sol", "MockForwarder": "MockForwarder.sol"}
for name, f in names.items():
    p = os.path.join(ROOT, "contracts", "out", f, name + ".json")
    if not os.path.exists(p):
        print("warning: no artifact for", name)
        continue
    json.dump(json.load(open(p))["abi"], open(os.path.join(abi_dir, name + ".json"), "w"), indent=2)
print("abis ->", abi_dir)
