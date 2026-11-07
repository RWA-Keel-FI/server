#!/usr/bin/env python3
"""Add-more-stocks stages for Arc Testnet (cast send; see arc_stages.py for why not forge script).

  arc_add_stocks.py seed    for each ticker in TICKERS: write one live quote to the oracle, mint t<TICKER> through the issuer, add
                            wide/medium/tight liquidity to its hook pool and control pool.
                            The oracle is currently owned by Chainlink's production forwarder, so this briefly makes the deployer the
                            forwarder and ALWAYS restores the production forwarder at the end (also if a step fails).
  arc_add_stocks.py merge   merge the new tickers (parsed from the AddStocksArc log) into the deployment manifest.

Env: RPC, SENDER, DEPLOYER_PRIVATE_KEY, ORACLE, ISSUER, LIQ_ROUTER, TICKERS="NVDA,AAPL", PRICE_E8_<SYM>, SIGMA_E12_<SYM>, LOG (forge log),
     BASE_MANIFEST, OUT_MANIFEST. Optional: LP_WIDE_USDC_E6 LP_MEDIUM_USDC_E6 LP_TIGHT_USDC_E6 (default 300000 = 0.30 USDC each, per pool).
The deployer key is passed to `cast send --private-key` (visible in the local process list during each call; never printed; output is redacted).
"""
import json, math, os, subprocess, sys, time

E = os.environ
RPC = E["RPC"]
KEY = E["DEPLOYER_PRIVATE_KEY"]
SENDER = E["SENDER"]
USDC = "0x3600000000000000000000000000000000000000"
FORWARDER = "0x76c9cf548b4179F8901cda1f8623568b58215E62"  # Chainlink production KeystoneForwarder (arc-testnet)
SPACING, DYNAMIC_FEE, BASE_FEE = 60, 0x800000, 3000
ZERO = "0x0000000000000000000000000000000000000000"


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
    r = json.loads(run(["cast", "send", "--rpc-url", RPC, "--legacy", "--json", "--private-key", KEY, "--", to, sig, *map(str, args)]))
    if int(r["status"], 16) != 1:
        raise SystemExit(f"tx reverted: {sig} {r['transactionHash']}")
    return r


def bal(token, who=None):
    return first_int(call(token, "balanceOf(address)(uint256)", who or SENDER))


def parse_log(path):
    """TICKER|SYM|field|value and POOL|SYM|kind|field|value lines printed by AddStocksArc -> {sym: {...}}"""
    out = {}
    for raw in open(path, encoding="utf-8", errors="replace"):
        line = raw.strip()
        parts = [p.strip() for p in line.split("|")]
        if parts[0] == "TICKER" and len(parts) == 4:
            out.setdefault(parts[1], {})[parts[2]] = parts[3]
        elif parts[0] == "POOL" and len(parts) == 5:
            out.setdefault(parts[1], {}).setdefault(parts[2], {})[parts[3]] = parts[4]
    return out


def tick_center(price_e8, stock_is_c0):
    p_raw = (price_e8 * 1e6) / (1e8 * 1e18) if stock_is_c0 else (1e8 * 1e18) / (price_e8 * 1e6)
    return math.floor(math.log(p_raw) / math.log(1.0001))


def rng(c, kind):
    if kind == 0:
        top = (887272 // SPACING) * SPACING
        return -top, top
    w = 960 if kind == 1 else 240
    fl = lambda t: (t // SPACING) * SPACING
    return fl(c - w), fl(c + w) + SPACING


def push_price(oracle, feed, price_e8):
    last_ts = first_int(run(["cast", "block", "latest", "--field", "timestamp", "--rpc-url", RPC]))
    old = call(oracle, "priceOf(bytes32)(uint64,uint64,bool)", feed).split("\n")
    asof = max(last_ts, int(old[1].split()[0]) + 1)
    report = run(["cast", "abi-encode", "f(bytes32,uint64,bool,uint64)", feed, str(price_e8), "true", str(asof)])
    r = send(oracle, "onReport(bytes,bytes)", "0x", report)
    return r["transactionHash"]


def seed_one(sym, info):
    oracle, issuer, lr = E["ORACLE"], E["ISSUER"], E["LIQ_ROUTER"]
    feed = info["feedId"]
    token = info["token"]
    price_e8 = int(E[f"PRICE_E8_{sym}"])
    stock_is_c0 = info["stockIsCurrency0"] == "true"
    k0, k1 = (token, USDC) if stock_is_c0 else (USDC, token)
    wide, med, tight = (int(E.get(n, 300_000)) for n in ("LP_WIDE_USDC_E6", "LP_MEDIUM_USDC_E6", "LP_TIGHT_USDC_E6"))
    total_quote = (wide + med + tight) * 2
    mint_usdc = total_quote + total_quote // 50 + 10
    print(f"[{sym}] price ${price_e8/1e8:.2f}  token {token}")
    print(f"[{sym}] oracle write tx={push_price(oracle, feed, price_e8)}")
    send(USDC, "approve(address,uint256)", issuer, mint_usdc)
    r = send(issuer, "mint(bytes32,uint256)", feed, mint_usdc)
    print(f"[{sym}] minted for {mint_usdc/1e6} USDC  tx={r['transactionHash']}  t{sym}={bal(token)/1e18:.6f}")
    maxu = 2**256 - 1
    send(USDC, "approve(address,uint256)", lr, maxu)
    send(token, "approve(address,uint256)", lr, maxu)
    c = tick_center(price_e8, stock_is_c0)
    for kind, usd in ((0, wide), (1, med), (2, tight)):
        lo, hi = rng(c, kind)
        for hooked in (True, False):
            tup = f"({k0},{k1},{DYNAMIC_FEE if hooked else BASE_FEE},{SPACING},{E['HOOK'] if hooked else ZERO})"
            tok = bal(token)
            a0, a1 = (tok, usd) if stock_is_c0 else (usd, tok)
            r = send(lr, "addLiquidityAmounts((address,address,uint24,int24,address),int24,int24,uint256,uint256)", tup, lo, hi, a0, a1)
            print(f"[{sym}] LP {['wide','medium','tight'][kind]:6s} {'hook   ' if hooked else 'control'} tx={r['transactionHash']}")


def stage_seed():
    info = parse_log(E["LOG"])
    syms = [s for s in E["TICKERS"].split(",") if s]
    missing = [s for s in syms if s not in info or "token" not in info[s]]
    if missing:
        raise SystemExit(f"deploy log has no token for: {missing}")
    oracle = E["ORACLE"]
    current = call(oracle, "getForwarderAddress()(address)").strip()
    if current.lower() not in (FORWARDER.lower(), SENDER.lower()):
        raise SystemExit(f"oracle forwarder is {current}, expected the production forwarder or the deployer; refusing to change it")
    print(f"USDC before: {bal(USDC)/1e6}  (oracle forwarder now {current})")
    try:
        if current.lower() != SENDER.lower():
            send(oracle, "setForwarderAddress(address)", SENDER)
            print("oracle forwarder -> deployer (temporary)")
        for sym in syms:
            seed_one(sym, info[sym])
    finally:
        send(oracle, "setForwarderAddress(address)", FORWARDER)
        got = call(oracle, "getForwarderAddress()(address)").strip()
        print(f"oracle forwarder restored -> {got}")
        if got.lower() != FORWARDER.lower():
            print("!!! WARNING: forwarder NOT restored; run setForwarderAddress by hand", file=sys.stderr)
    print(f"USDC after: {bal(USDC)/1e6}")


def pool_obj(p):
    return {"poolId": p["poolId"], "key": {"currency0": p["currency0"], "currency1": p["currency1"], "fee": int(p["fee"]),
                                           "tickSpacing": int(p["tickSpacing"]), "hooks": p["hooks"]}}


def stage_merge():
    info = parse_log(E["LOG"])
    m = json.load(open(E["BASE_MANIFEST"]))
    for sym, t in info.items():
        if "hookPool" not in t:
            continue
        m["tickers"][sym] = {"feedId": t["feedId"], "token": t["token"], "startPriceE8": int(t["startPriceE8"]), "sigmaE12": int(t["sigmaE12"]),
                             "stockIsCurrency0": t["stockIsCurrency0"] == "true", "hookPool": pool_obj(t["hookPool"]), "controlPool": pool_obj(t["controlPool"])}
        print("merged", sym)
    json.dump(m, open(E["OUT_MANIFEST"], "w"), indent=2)
    print("wrote", E["OUT_MANIFEST"], "tickers:", ", ".join(m["tickers"]))


if __name__ == "__main__":
    {"seed": stage_seed, "merge": stage_merge}[sys.argv[1]]()
