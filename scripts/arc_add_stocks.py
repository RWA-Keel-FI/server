#!/usr/bin/env python3
"""Add-more-stocks stages for Arc Testnet (cast send; see arc_stages.py for why not forge script).

  arc_add_stocks.py create  for each ticker in TICKERS: deploy t<TICKER> (owned by the issuer), list it, register + initialise the hook pool and
                            the control pool at the live price. Resumable: anything already done on-chain is detected and reused.
                            Writes INFO (json) for the next stages.
  arc_add_stocks.py seed    for each ticker in TICKERS: write one live quote to the oracle, mint t<TICKER> through the issuer, add
                            wide/medium/tight liquidity to its hook pool and control pool.
                            The oracle is currently owned by Chainlink's production forwarder, so this briefly makes the deployer the
                            forwarder and ALWAYS restores the production forwarder at the end (also if a step fails).
  arc_add_stocks.py merge   merge the new tickers (parsed from the AddStocksArc log) into the deployment manifest.

Env: RPC, SENDER, DEPLOYER_PRIVATE_KEY, ORACLE, HOOK, ISSUER, LIQ_ROUTER, TICKERS="NVDA,AAPL", PRICE_E8_<SYM>, SIGMA_E12_<SYM>, INFO (json),
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


def _nonce(block):
    return int(run(["cast", "nonce", "--rpc-url", RPC, "--block", block, SENDER]))


def _send_with_nonce(tail, label):
    """Send with an explicit nonce so a retry can never submit the same action twice.
    If an attempt actually landed but cast lost the receipt (timeout / 429), the retry is rejected as 'nonce too low' / 'already known';
    that is treated as success once the chain's nonce has moved past ours."""
    nonce = _nonce("pending")
    cmd = ["cast", "send", "--rpc-url", RPC, "--legacy", "--json", "--private-key", KEY, "--nonce", str(nonce)] + tail
    last = ""
    for i in range(6):
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode == 0:
            r = json.loads(p.stdout)
            if int(r["status"], 16) != 1:
                raise SystemExit(f"tx reverted: {label} {r['transactionHash']}")
            return r
        last = (p.stderr + p.stdout).replace(KEY, "<redacted>").replace(KEY[2:], "<redacted>")
        low = last.lower()
        if "nonce too low" in low or "already known" in low or "already imported" in low:
            for _ in range(40):  # the earlier attempt landed or is pending: wait until the chain nonce has passed ours
                if _nonce("latest") > nonce:
                    return {"transactionHash": "(landed on an earlier attempt)", "status": "0x1", "nonce": nonce}
                time.sleep(3)
            raise SystemExit(f"{label}: nonce {nonce} still pending after 2 minutes; check the explorer before rerunning")
        if "429" in low or "rate limit" in low or "timed out" in low or "timeout" in low or "error sending request" in low:
            time.sleep(2 * (i + 1)); continue
        raise SystemExit(f"cast failed: {label} ...\n{last[-600:]}")
    raise SystemExit(f"cast failed after retries: {label}\n{last[-400:]}")


def send(to, sig, *args):
    return _send_with_nonce(["--", to, sig, *map(str, args)], sig)


def deploy(initcode):
    nonce_before = _nonce("pending")
    r = _send_with_nonce(["--create", initcode], "create")
    if "contractAddress" not in r or not r["contractAddress"]:
        r["contractAddress"] = run(["cast", "compute-address", SENDER, "--nonce", str(nonce_before), "--rpc-url", RPC]).split()[-1]
    return r


def bal(token, who=None):
    return first_int(call(token, "balanceOf(address)(uint256)", who or SENDER))


def load_info():
    return json.load(open(E["INFO"]))


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


POOL_MANAGER = "0x1d70945634F618eefdF9EDaAdB59B9A183CEF929"


def sqrt_price_x96(price_e8, stock_is_c0):
    """same math as ArcCommon._sqrtFor: stock has 18 decimals, USDC 6"""
    if stock_is_c0:
        q192 = (price_e8 * 10**6) * (1 << 192) // (10**8 * 10**18)
    else:
        q192 = (10**8 * 10**18) * (1 << 192) // (price_e8 * 10**6)
    return math.isqrt(q192)


def pool_tuple(k0, k1, fee, hooks):
    return f"({k0},{k1},{fee},{SPACING},{hooks})"


def pool_id(k0, k1, fee, hooks):
    return run(["cast", "keccak", run(["cast", "abi-encode", "f(address,address,uint24,int24,address)", k0, k1, str(fee), str(SPACING), hooks])])


def pool_initialised(pid):
    slot = run(["cast", "keccak", run(["cast", "abi-encode", "f(bytes32,uint256)", pid, "6"])])
    word = int(run(["cast", "storage", "--rpc-url", RPC, POOL_MANAGER, slot]), 16)
    return (word & ((1 << 160) - 1)) != 0


def stage_create():
    issuer, hook = E["ISSUER"], E["HOOK"]
    art = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "contracts", "out", "StockToken.sol", "StockToken.json")))
    bytecode = art["bytecode"]["object"]
    syms = [s for s in E["TICKERS"].split(",") if s]
    out = {}
    for sym in syms:
        feed = "0x" + sym.encode().hex().ljust(64, "0")
        price_e8 = int(E[f"PRICE_E8_{sym}"]); sigma = int(E[f"SIGMA_E12_{sym}"])
        token = call(issuer, "tokenOf(bytes32)(address)", feed).strip()
        if int(token, 16) == 0:
            ctor = run(["cast", "abi-encode", "constructor(string,string,address)", f"Test {sym} (mock)", f"t{sym}", issuer])
            token = deploy(bytecode + ctor[2:])["contractAddress"]
            send(issuer, "listTicker(bytes32,address)", feed, token)
            print(f"[{sym}] deployed + listed t{sym} {token}")
        else:
            print(f"[{sym}] already listed: {token} (reused)")
        c0 = int(token, 16) < int(USDC, 16)
        k0, k1 = (token, USDC) if c0 else (USDC, token)
        hid, cid = pool_id(k0, k1, DYNAMIC_FEE, hook), pool_id(k0, k1, BASE_FEE, ZERO)
        hook_key, ctl_key = pool_tuple(k0, k1, DYNAMIC_FEE, hook), pool_tuple(k0, k1, BASE_FEE, ZERO)
        cfg = call(hook, "poolConfig(bytes32)(bytes32,uint24,uint24,uint32,uint64,uint8,bool,bool,bool)", hid).split("\n")
        configured = cfg[7].strip().startswith("true")
        sp = sqrt_price_x96(price_e8, c0)
        if not configured:
            send(hook, "configurePool((address,address,uint24,int24,address),(bytes32,bool,uint24,uint24,uint32,uint64))",
                 hook_key, f"({feed},{str(c0).lower()},{BASE_FEE},0,0,{sigma})")
            print(f"[{sym}] hook pool configured")
        for label, key, pid in (("hook", hook_key, hid), ("control", ctl_key, cid)):
            if not pool_initialised(pid):
                send(POOL_MANAGER, "initialize((address,address,uint24,int24,address),uint160)", key, sp)
                print(f"[{sym}] {label} pool initialised {pid}")
            else:
                print(f"[{sym}] {label} pool already initialised {pid}")
        po = lambda fee, hooks, pid: {"poolId": pid, "currency0": k0, "currency1": k1, "fee": str(fee), "tickSpacing": str(SPACING), "hooks": hooks}
        out[sym] = {"feedId": feed, "token": token, "startPriceE8": str(price_e8), "sigmaE12": str(sigma), "stockIsCurrency0": "true" if c0 else "false",
                    "hookPool": po(DYNAMIC_FEE, hook, hid), "controlPool": po(BASE_FEE, ZERO, cid)}
    json.dump(out, open(E["INFO"], "w"), indent=2)
    print("wrote", E["INFO"])


def seed_one(sym, info):
    """Resumable: only adds the liquidity positions that do not exist yet, and only mints / writes a price when tokens are actually needed."""
    oracle, issuer, lr = E["ORACLE"], E["ISSUER"], E["LIQ_ROUTER"]
    feed = info["feedId"]
    token = info["token"]
    price_e8 = int(E[f"PRICE_E8_{sym}"])
    stock_is_c0 = info["stockIsCurrency0"] == "true"
    k0, k1 = (token, USDC) if stock_is_c0 else (USDC, token)
    wide, med, tight = (int(E.get(n, 300_000)) for n in ("LP_WIDE_USDC_E6", "LP_MEDIUM_USDC_E6", "LP_TIGHT_USDC_E6"))
    c = tick_center(price_e8, stock_is_c0)
    missing = []
    for kind, usd in ((0, wide), (1, med), (2, tight)):
        lo, hi = rng(c, kind)
        for hooked in (True, False):
            tup = f"({k0},{k1},{DYNAMIC_FEE if hooked else BASE_FEE},{SPACING},{E['HOOK'] if hooked else ZERO})"
            liq = first_int(call(lr, "liquidityOf((address,address,uint24,int24,address),address,int24,int24)(uint128)", tup, SENDER, lo, hi))
            if liq == 0:
                missing.append((kind, usd, hooked, lo, hi, tup))
    if not missing:
        print(f"[{sym}] all 6 liquidity positions already exist, skipping")
        return
    need_usd = sum(m[1] for m in missing)  # USDC micro-units; each position takes about the same value of stock tokens
    have_usd = bal(token) * price_e8 // 10**8 // 10**12  # token value in USDC micro-units
    print(f"[{sym}] price ${price_e8/1e8:.2f}  token {token}  positions to add: {len(missing)}")
    if have_usd < need_usd * 98 // 100:
        mint_usdc = need_usd * 102 // 100 - have_usd + 10
        print(f"[{sym}] oracle write tx={push_price(oracle, feed, price_e8)}")
        send(USDC, "approve(address,uint256)", issuer, mint_usdc)
        r = send(issuer, "mint(bytes32,uint256)", feed, mint_usdc)
        print(f"[{sym}] minted for {mint_usdc/1e6} USDC  tx={r['transactionHash']}  t{sym}={bal(token)/1e18:.6f}")
    maxu = 2**256 - 1
    send(USDC, "approve(address,uint256)", lr, maxu)
    send(token, "approve(address,uint256)", lr, maxu)
    for kind, usd, hooked, lo, hi, tup in missing:
        tok = bal(token) * 999 // 1000  # tiny margin: the router rounds the pulled amounts up and can exceed the budget by a wei
        a0, a1 = (tok, usd) if stock_is_c0 else (usd, tok)
        r = send(lr, "addLiquidityAmounts((address,address,uint24,int24,address),int24,int24,uint256,uint256)", tup, lo, hi, a0, a1)
        print(f"[{sym}] LP {['wide','medium','tight'][kind]:6s} {'hook   ' if hooked else 'control'} tx={r['transactionHash']}")


def stage_seed():
    info = load_info()
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
    info = load_info()
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
    {"create": stage_create, "seed": stage_seed, "merge": stage_merge}[sys.argv[1]]()
