#!/usr/bin/env python3
"""Post-deploy stages for Arc Testnet, driven by `cast send` (NOT forge script).

Why not forge script: Arc's USDC ERC-20 moves balances through chain precompiles (0x1800...0000/0001) that forge's
local EVM does not have, so a forge script cannot simulate any step that moves USDC. `cast send` skips the local
simulation and the real chain executes the call.

  arc_stages.py seed       write one real TSLA quote to the oracle, mint tTSLA, add wide/medium/tight liquidity to the
                           hook pool and the control pool
  arc_stages.py showcase   fresh oracle write, then: retail swap (hook + control), a price-pushing swap, the arbitrage
                           swap back toward the reference. Writes deployments/<name>-showcase.json
  arc_stages.py handover   oracle.setForwarderAddress(real Chainlink KeystoneForwarder)

Env (exported by deploy-arc.sh): RPC, SENDER, DEPLOYER_PRIVATE_KEY (passed to `cast send --private-key`, so it is visible in
the local process list for the duration of each call; never printed, error output is redacted),
ORACLE HOOK ISSUER SWAP_ROUTER LIQ_ROUTER TOKEN, PRICE_E8_TSLA, SHOWCASE_NAME.
Optional sizing (USDC micro-units): LP_WIDE_USDC_E6 LP_MEDIUM_USDC_E6 LP_TIGHT_USDC_E6 SHOW_RETAIL_USDC_E6 SHOW_PUSH_USDC_E6
"""
import json, math, os, subprocess, sys, time

RPC = os.environ["RPC"]
USDC = "0x3600000000000000000000000000000000000000"
POOL_MANAGER = "0x1d70945634F618eefdF9EDaAdB59B9A183CEF929"
FORWARDER = "0x76c9cf548b4179F8901cda1f8623568b58215E62"
FEED = "0x" + b"TSLA".hex().ljust(64, "0")
SPACING = 60
DYNAMIC_FEE = 0x800000
BASE_FEE = 3000
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
E = os.environ
ORACLE, HOOK, ISSUER, SR, LR, TOKEN = (E[k] for k in ("ORACLE", "HOOK", "ISSUER", "SWAP_ROUTER", "LIQ_ROUTER", "TOKEN"))
KEY = E["DEPLOYER_PRIVATE_KEY"]
PRICE_E8 = int(E["PRICE_E8_TSLA"])
STOCK_IS_C0 = int(TOKEN, 16) < int(USDC, 16)


def run(cmd, retries=6):
    for i in range(retries):
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode == 0:
            return p.stdout.strip()
        err = (p.stderr + p.stdout).replace(KEY, "<redacted>").replace(KEY[2:], "<redacted>")
        if "429" in err or "rate limit" in err.lower() or "timed out" in err.lower():
            time.sleep(2 * (i + 1)); continue
        raise SystemExit(f"cast failed: {cmd[1]} ...\n{err[-600:]}")
    raise SystemExit("cast failed after retries (rate limited?)")


def call(to, sig, *args):
    return run(["cast", "call", "--rpc-url", RPC, "--", to, sig, *map(str, args)])


def first_int(s):
    return int(s.split()[0].replace(",", ""))


def send(to, sig, *args):
    out = run(["cast", "send", "--rpc-url", RPC, "--legacy", "--json", "--private-key", KEY, "--", to, sig, *map(str, args)])
    r = json.loads(out)
    if int(r["status"], 16) != 1:
        raise SystemExit(f"tx reverted: {sig} {r['transactionHash']}")
    return r


SENDER = E["SENDER"]

key0, key1 = (TOKEN, USDC) if STOCK_IS_C0 else (USDC, TOKEN)


def pool_tuple(hooked):
    return f"({key0},{key1},{DYNAMIC_FEE if hooked else BASE_FEE},{SPACING},{HOOK if hooked else '0x0000000000000000000000000000000000000000'})"


def pool_id(hooked):
    enc = run(["cast", "abi-encode", "f(address,address,uint24,int24,address)", key0, key1,
               str(DYNAMIC_FEE if hooked else BASE_FEE), str(SPACING), HOOK if hooked else "0x0000000000000000000000000000000000000000"])
    return run(["cast", "keccak", enc])


def sqrt_price_x96(pool):
    # PoolManager slot0 lives at keccak(poolId . 6) (StateLibrary POOLS_SLOT = 6); low 160 bits = sqrtPriceX96
    slot = run(["cast", "keccak", run(["cast", "abi-encode", "f(bytes32,uint256)", pool_id(pool), "6"])])
    word = int(run(["cast", "storage", POOL_MANAGER, slot, "--rpc-url", RPC]), 16)
    return word & ((1 << 160) - 1), (word >> 160) & 0xFFFFFF  # sqrtPrice, tick (24-bit, ignore sign here)


def usd_price(hooked=True):
    sp, _ = sqrt_price_x96(hooked)
    p = (sp / 2**96) ** 2  # token1 per token0, raw units
    return p * 1e12 if STOCK_IS_C0 else 1e12 / p  # stock 18 dec vs USDC 6 dec


def tick_center():
    # tick of the start price, same convention as the on-chain pool initialisation (ArcCommon._sqrtFor)
    p_raw = (PRICE_E8 * 1e6) / (1e8 * 1e18) if STOCK_IS_C0 else (1e8 * 1e18) / (PRICE_E8 * 1e6)  # token1/token0 raw
    return math.floor(math.log(p_raw) / math.log(1.0001))


def floor_spacing(t):
    return (t // SPACING) * SPACING


def rng(c, kind):
    if kind == 0:
        top = (887272 // SPACING) * SPACING
        return -top, top
    w = 960 if kind == 1 else 240
    return floor_spacing(c - w), floor_spacing(c + w) + SPACING


def bal(token, who=None):
    return first_int(call(token, "balanceOf(address)(uint256)", who or SENDER))


def push_price():
    last_ts = first_int(run(["cast", "block", "latest", "--field", "timestamp", "--rpc-url", RPC]))
    old = call(ORACLE, "priceOf(bytes32)(uint64,uint64,bool)", FEED).split("\n")
    old_asof = int(old[1].split()[0])
    asof = max(last_ts, old_asof + 1)
    report = run(["cast", "abi-encode", "f(bytes32,uint64,bool,uint64)", FEED, str(PRICE_E8), "true", str(asof)])
    r = send(ORACLE, "onReport(bytes,bytes)", "0x", report)
    print(f"  oracle price written: ${PRICE_E8/1e8:.2f} asOf={asof} tx={r['transactionHash']}")
    return r["transactionHash"]


def fee_logs(receipt):
    """decode FeeSet(bytes32 indexed poolId, uint24 fee, uint24 f0, uint32 deviationBps, bool armed) from a receipt"""
    topic = run(["cast", "keccak", "FeeSet(bytes32,uint24,uint24,uint32,bool)"])
    out = []
    for lg in receipt["logs"]:
        if lg["topics"] and lg["topics"][0].lower() == topic.lower() and lg["address"].lower() == HOOK.lower():
            d = lg["data"][2:]
            w = [int(d[i:i + 64], 16) for i in range(0, 192, 64)] + [int(d[192:256], 16)]
            out.append({"feePips": w[0], "baseFeePips": w[1], "deviationBps": w[2], "armed": bool(w[3])})
    return out


def stage_seed():
    wide = int(E.get("LP_WIDE_USDC_E6", 1_000_000)); med = int(E.get("LP_MEDIUM_USDC_E6", 1_000_000)); tight = int(E.get("LP_TIGHT_USDC_E6", 1_000_000))
    total_quote = (wide + med + tight) * 2
    mint_usdc = total_quote + total_quote // 50 + 10
    print(f"seed: sender {SENDER}  USDC(ERC20) {bal(USDC)/1e6}")
    print(f"  hook pool price before: ${usd_price(True):.4f}")
    push_price()
    send(USDC, "approve(address,uint256)", ISSUER, mint_usdc)
    r = send(ISSUER, "mint(bytes32,uint256)", FEED, mint_usdc)
    print(f"  minted tTSLA for {mint_usdc/1e6} USDC  tx={r['transactionHash']}  tTSLA={bal(TOKEN)/1e18:.6f}")
    maxu = 2**256 - 1
    send(USDC, "approve(address,uint256)", LR, maxu)
    send(TOKEN, "approve(address,uint256)", LR, maxu)
    c = tick_center()
    for kind, usd in ((0, wide), (1, med), (2, tight)):
        lo, hi = rng(c, kind)
        for hooked in (True, False):
            tok = bal(TOKEN)
            a0, a1 = (tok, usd) if STOCK_IS_C0 else (usd, tok)
            r = send(LR, "addLiquidityAmounts((address,address,uint24,int24,address),int24,int24,uint256,uint256)",
                     pool_tuple(hooked), lo, hi, a0, a1)
            print(f"  LP {['wide','medium','tight'][kind]:6s} {'hook   ' if hooked else 'control'} ticks [{lo},{hi}] tx={r['transactionHash']}")
    print(f"seed done. leftover tTSLA {bal(TOKEN)/1e18:.6f}  USDC {bal(USDC)/1e6}")


def stage_showcase():
    retail = int(E.get("SHOW_RETAIL_USDC_E6", 50_000)); push = int(E.get("SHOW_PUSH_USDC_E6", 1_200_000))
    name = E.get("SHOWCASE_NAME", "arc-testnet")
    buy_zero_for_one = not STOCK_IS_C0   # paying USDC: zeroForOne iff USDC is currency0 (stock is currency1)
    log = {"sender": SENDER, "oracleNote": "reference price written by the deployer while it was the oracle's temporary forwarder; "
           "CRE takes over after handover", "referencePriceUsd": PRICE_E8 / 1e8, "steps": []}
    print("showcase:")
    log["oracleWriteTx"] = push_price()
    send(USDC, "approve(address,uint256)", SR, 2**256 - 1)
    send(TOKEN, "approve(address,uint256)", SR, 2**256 - 1)

    def swap(label, hooked, zero_for_one, amount):
        before = bal(TOKEN)
        r = send(SR, "swapExactIn((address,address,uint24,int24,address),bool,uint256,uint256)",
                 pool_tuple(hooked), str(zero_for_one).lower(), amount, 0)
        fees = fee_logs(r) if hooked else []
        gained = bal(TOKEN) - before
        step = {"label": label, "pool": "hook" if hooked else "control", "amountIn": amount, "tx": r["transactionHash"],
                "tokenDelta": gained, "feeSet": fees}
        log["steps"].append(step)
        f = (f"fee {fees[0]['feePips']/1e4:.2f}% (base {fees[0]['baseFeePips']/1e4:.2f}%, deviation {fees[0]['deviationBps']} bps, armed={fees[0]['armed']})"
             if fees else "fee 0.30% (static control pool)")
        print(f"  {label:42s} {f} tx={r['transactionHash']}")
        return gained

    print(f"  pool price before: ${usd_price(True):.4f} (reference ${PRICE_E8/1e8:.2f})")
    swap("1 retail buy  (hook pool)", True, buy_zero_for_one, retail)
    swap("2 retail buy  (control pool, same size)", False, buy_zero_for_one, retail)
    got = swap("3 big buy pushes pool away from reference", True, buy_zero_for_one, push)
    qf = call(HOOK, "quoteFee((address,address,uint24,int24,address),bool)(uint24,uint256,bool)", pool_tuple(True),
              str(not buy_zero_for_one).lower())
    print(f"  pool price after push: ${usd_price(True):.4f}")
    print("  quoteFee for the arb direction:", qf.replace("\n", " | "))
    sell_amt = max(got // 2, 1)
    swap("4 ARB sell back toward reference (pays extra)", True, not buy_zero_for_one, sell_amt)
    json.dump(log, open(os.path.join(ROOT, "deployments", f"{name}-showcase.json"), "w"), indent=2)
    print(f"showcase written -> deployments/{name}-showcase.json")


def stage_handover():
    r = send(ORACLE, "setForwarderAddress(address)", FORWARDER)
    got = call(ORACLE, "getForwarderAddress()(address)")
    if got.lower() != FORWARDER.lower():
        raise SystemExit(f"handover check failed: forwarder is {got}")
    print(f"oracle forwarder is now the real Chainlink KeystoneForwarder {got}  tx={r['transactionHash']}")


if __name__ == "__main__":
    {"seed": stage_seed, "showcase": stage_showcase, "handover": stage_handover}[sys.argv[1]]()
