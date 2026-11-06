"""DeviationFee backtest: replay real Uniswap swaps against the fee rule
      d      = |pool_px / ref_px - 1|
      d_eff  = max(0, d - SIGMA_MULT * sigma * sqrt(age))
      fee    = clamp(max(f0, K * d_eff), f_max)  if the swap moves the pool TOWARD ref (arbitrage direction)
      fee    = f0                                otherwise
Static replay: observed swaps are held fixed, only the fee changes (elasticity / chunking handled as scenarios).
usage: python3 -I analyze.py        (reads data/, writes results.json and tables.md)
"""
import json, os, sys, math, bisect, statistics as st, datetime as dt, collections
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import *
NY = ZoneInfo("America/New_York")

# ------------------------------------------------------------------ decode swaps
anchors = json.load(open(f"{DATA}/anchors.json"))
def blk_ts(b):
    for (b0, t0), (b1, t1) in zip(anchors, anchors[1:]):
        if b0 <= b <= b1: return t0 + (b - b0) * (t1 - t0) / (b1 - b0)
    return anchors[0][1] + (b - anchors[0][0]) * 12
def s256(h):
    v = int(h, 16); return v - (1 << 256) if v >> 255 else v

def decode(name):
    p = POOLS[name]; logs = json.load(open(f"{DATA}/logs_{name}.json")); S = []
    for l in logs:
        w = [l["data"][2 + 64 * i: 2 + 64 * (i + 1)] for i in range(len(l["data"][2:]) // 64)]
        S.append(dict(b=l["b"], i=l["i"], a0=s256(w[0]), a1=s256(w[1]), sq=int(w[2], 16),
                      fee=(int(w[5], 16) / 1e6 if p["kind"] == "v4" else p["fee"])))
    S.sort(key=lambda x: (x["b"], x["i"]))
    for s in S:
        pr = (s["sq"] / 2 ** 96) ** 2
        try: s["px"] = (1e12 / pr) if p["usdc0"] else pr * 1e12      # USD per stock token
        except ZeroDivisionError: s["px"] = float("inf")
        s["ts"] = blk_ts(s["b"])
    # sign convention: v3 amounts are pool-perspective; v4 swapper-perspective (auto-detected from price moves)
    agree = tot = 0
    for a, b in zip(S, S[1:]):
        d0 = b["sq"] - a["sq"]
        if b["a0"] == 0 or d0 == 0: continue
        agree += ((b["a0"] > 0) == (d0 < 0)); tot += 1
    flip = tot and agree / tot < 0.5
    for s in S:
        a0, a1 = (-s["a0"], -s["a1"]) if flip else (s["a0"], s["a1"])
        s["usdc"] = (a0 if p["usdc0"] else a1) / 1e6        # + = pool received USDC
        s["stock"] = (a1 if p["usdc0"] else a0) / 1e18      # + = pool received stock token
    return S

# ------------------------------------------------------------------ price / reference
def load_bars(t, kind):
    d = json.load(open(f"{DATA}/px_{t}_{kind}.json")); return d
class Ref:
    """Oracle model: at every bar start the oracle publishes that bar's OPEN (no look-ahead); age = t - bar start."""
    def __init__(self, bars, cadence): self.ts, self.op, self.max_age = bars["ts"], bars["open"], min(cadence, STALE_S)
    def at(self, t):
        i = bisect.bisect_right(self.ts, t) - 1
        if i < 0: return None
        age = t - self.ts[i]
        # no bar within one cadence => session closed / reference stale => hook fails open (fee = f0); swap excluded from the replay
        return (self.op[i], age) if age <= self.max_age else None
def sigma_per_sqrt_s(t):
    b = load_bars(t, "5m"); ts, op = b["ts"], b["open"]
    r = [math.log(op[i + 1] / op[i]) for i in range(len(op) - 1) if ts[i + 1] - ts[i] == 300]
    return st.pstdev(r) / math.sqrt(300)

def is_rth(t):
    d = dt.datetime.fromtimestamp(t, NY); h = d.hour + d.minute / 60
    return d.weekday() < 5 and 10 <= h < 15.5

def estimate_basis(S, tk, win_start, f_act, days=45):
    """Out-of-sample persistent offset of pool vs stock: median RTH deviation over the `days` BEFORE the window.
    Applied only if |median| > 2*f_act (i.e. outside the no-arbitrage band => not explained by fees)."""
    b = load_bars(tk, "1h"); ts, op = b["ts"], b["open"]; vals = []
    for s in S:
        if not (win_start - days * 86400 <= s["ts"] < win_start) or not is_rth(s["ts"]): continue
        i = bisect.bisect_right(ts, s["ts"]) - 1
        if i >= 0 and s["ts"] - ts[i] <= 3600 and 0.2 < s["px"] / op[i] < 5: vals.append(s["px"] / op[i] - 1)
    if len(vals) < 30: return 0.0, len(vals), None
    m = st.median(vals); return (m if abs(m) > 2 * f_act else 0.0), len(vals), m

# ------------------------------------------------------------------ records (one per usable swap)
def build_records(S, tk, ref, win_start, basis):
    recs = []; ex = collections.Counter(); prev = None
    for s in S:
        if prev is not None and s["ts"] >= win_start:
            v = abs(s["usdc"])
            x = ref.at(s["ts"])
            if v < 1 or v > MAX_NOTIONAL: ex["size"] += 1
            elif x is None: ex["no_reference(closed/stale)"] += 1
            else:
                r = x[0] * (1 + basis); age = x[1]; p0 = prev["px"]
                d = abs(p0 / r - 1) if math.isfinite(p0) and p0 > 0 else 9
                if d > DISLOC: ex["pool_dislocated(>25%)"] += 1
                else:
                    p1 = s["px"]; p1 = p1 if (math.isfinite(p1) and abs(p1 / r - 1) < DISLOC) else p0
                    mo = s["usdc"] + s["stock"] * r                    # LP gain incl. actual fee, marked at fair r
                    arb = (s["stock"] > 0) if p0 > r else (s["stock"] < 0)   # pushes pool price toward r
                    recs.append(dict(id=(s['b'], s['i']), ts=s['ts'], v=v, p0=p0, p1=p1, r=r, age=age, d=d, arb=arb, mo=mo, edge=mo - s["fee"] * v, fa=s["fee"]))
        prev = s
    return recs, dict(ex)

# ------------------------------------------------------------------ rule + simulation
def fee_rule(d, age, f0, k, sigm, sigma, fmax=None):
    fmax = F_MAX if fmax is None else fmax
    deff = max(0.0, d - sigm * sigma * math.sqrt(max(age, 1)))
    return min(max(f0, k * deff), max(fmax, f0))

def simulate(recs, sigma, f0=None, k=K, sigm=SIGMA_MULT, n=1, x=0.0, mode='remove', fmax=None):
    """f0=None -> keep each pool's actual fee as base. n = chunking adversary (arb splits each swap in n equal pieces,
    fee evaluated on the running deviation). x = fraction of SURCHARGED volume that is lost (elasticity)."""
    R = dict(n=0, n_sur=0, vol=0.0, vol_sur=0.0, n_small=0, n_small_sur=0, base=0.0, new=0.0, extra=0.0,
             sur_bps=[], extras=[], nonarb_sur=0, fair_violations=0)
    for c in recs:
        base_f = c["fa"] if f0 is None else f0
        if c["arb"]:
            if n == 1: fee = fee_rule(c["d"], c["age"], base_f, k, sigm, sigma, fmax)
            else:
                fee = 0.0
                for j in range(n):
                    pj = c["p0"] + (c["p1"] - c["p0"]) * j / n
                    # a piece that starts on the far side of ref (swap overshot) is NOT arb-direction any more -> base fee
                    if (pj - c["r"]) * (c["p0"] - c["r"]) <= 0: fee += base_f; continue
                    fee += fee_rule(abs(pj / c["r"] - 1), c["age"], base_f, k, sigm, sigma, fmax)
                fee /= n
        else: fee = base_f
        sur = fee > base_f + 1e-12
        contrib = c["edge"] + fee * c["v"]
        if sur:
            # elasticity: 'remove'   = a lost swap vanishes entirely (its adverse selection is avoided too)
            #             'fees_only' = pessimistic: the fee income is lost but the adverse selection is still suffered
            contrib = contrib * (1 - x) if mode == "remove" else c["edge"] + (1 - x) * fee * c["v"]
            R["n_sur"] += 1; R["vol_sur"] += c["v"]; R["sur_bps"].append((fee - base_f) * 1e4)
            R["extra"] += (fee - base_f) * c["v"]; R["extras"].append((fee - base_f) * c["v"])
            if not c["arb"]: R["nonarb_sur"] += 1
            # never-worse-than-fair: arb-direction user's execution vs reference after the (new) fee
            p, r = c["p0"], c["r"]
            if (p > r and p * (1 - fee) < r - 1e-12) or (p < r and p / (1 - fee) > r + 1e-12): R["fair_violations"] += 1
        R["n"] += 1; R["vol"] += c["v"]; R["base"] += c["mo"]; R["new"] += contrib
        if c["v"] < SMALL_USD:
            R["n_small"] += 1; R["n_small_sur"] += sur
    return R
def summarize(R):
    b = R["sur_bps"]
    return dict(swaps=R["n"], volume=round(R["vol"]), base_pnl=round(R["base"], 1), new_pnl=round(R["new"], 1),
                delta_pnl=round(R["new"] - R["base"], 1), delta_pct=round((R["new"] - R["base"]) / abs(R["base"]) * 100, 2) if R["base"] else None,
                pct_swaps_surcharged=round(R["n_sur"] / R["n"] * 100, 2) if R["n"] else None,
                pct_volume_surcharged=round(R["vol_sur"] / R["vol"] * 100, 2) if R["vol"] else None,
                pct_small_swaps_surcharged=round(R["n_small_sur"] / R["n_small"] * 100, 2) if R["n_small"] else None,
                n_small=R["n_small"], n_small_sur=R["n_small_sur"], extra_fee_usd=round(R["extra"], 1),
                avg_surcharge_bps=round(st.mean(b), 1) if b else 0, p99_surcharge_bps=round(sorted(b)[int(0.99 * (len(b) - 1))], 1) if b else 0,
                avg_extra_bps_all_volume=round(R["extra"] / R["vol"] * 1e4, 2) if R["vol"] else None,
                nonarb_swaps_surcharged=R["nonarb_sur"], fair_price_violations=R["fair_violations"],
                top10_share_of_extra_fee_pct=round(sum(sorted(R['extras'], reverse=True)[:10]) / R['extra'] * 100, 1) if R['extra'] > 0 else None,
                largest_single_extra_fee_usd=round(max(R['extras']), 1) if R['extras'] else 0)
def pool_totals(Rs):
    T = collections.Counter()
    for R in Rs:
        for k in ("n", "n_sur", "vol", "vol_sur", "n_small", "n_small_sur", "base", "new", "extra", "nonarb_sur", "fair_violations"): T[k] += R[k]
        T.setdefault("sur_bps", []); 
    out = dict(T); out["sur_bps"] = [b for R in Rs for b in R["sur_bps"]]; out["extras"] = [e for R in Rs for e in R["extras"]]; return out

# ------------------------------------------------------------------ main
if __name__ == "__main__":
    SIG = {t: sigma_per_sqrt_s(t) for t in TICKERS}
    b5 = {t: Ref(load_bars(t, "5m"), 300) for t in TICKERS}; b1 = {t: Ref(load_bars(t, "1m"), 60) for t in TICKERS}
    win5 = {t: b5[t].ts[0] for t in TICKERS}; win1 = {t: b1[t].ts[0] for t in TICKERS}
    print("sigma (bps/sqrt s):", {t: round(v * 1e4, 3) for t, v in SIG.items()})
    res = dict(meta=dict(generated=dt.datetime.utcnow().isoformat() + "Z", rule="fee=clamp(max(f0,K*d_eff)) if arb-direction else f0",
                         K=K, SIGMA_MULT=SIGMA_MULT, F_MAX=F_MAX, STALE_S=STALE_S, DISLOC=DISLOC, SMALL_USD=SMALL_USD,
                         sigma_bps_per_sqrt_s={t: round(v * 1e4, 3) for t, v in SIG.items()},
                         window_5m=[dt.datetime.fromtimestamp(min(win5.values()), NY).isoformat(), "now"],
                         window_1m=[dt.datetime.fromtimestamp(min(win1.values()), NY).isoformat(), "now"]),
               pools={}, sens={}, notes={})
    REC5, REC1, REC5_raw = {}, {}, {}
    for name, p in POOLS.items():
        S = decode(name); tk = p["stock"]
        absurd = sum(1 for s in S if not math.isfinite(s["px"]) or s["px"] > 1e5 or s["px"] < 1e-3)   # liquidity exhausted -> price at tick bound
        f_act_med = st.median(s["fee"] for s in S)
        basis, nb, med = estimate_basis(S, tk, win5[tk], f_act_med)
        r5, ex5 = build_records(S, tk, b5[tk], win5[tk], basis)
        r1, ex1 = build_records(S, tk, b1[tk], win1[tk], basis)
        REC5[name], REC1[name] = r5, r1
        if basis: REC5_raw[name], _ = build_records(S, tk, b5[tk], win5[tk], 0.0)
        res["pools"][name] = dict(stock=tk, swaps_total=len(S), absurd_pool_prices_all_time=absurd, base_fee_median_bps=f_act_med * 1e4,
                                  basis_applied_bps=round(basis * 1e4, 1), basis_median_oos_bps=None if med is None else round(med * 1e4, 1), basis_n=nb,
                                  excluded_5m=ex5, excluded_1m=ex1, usable_5m=len(r5), usable_1m=len(r1))
        print(name, "swaps", len(S), "absurd px", absurd, "basis", round(basis * 1e4, 1), "(oos median", None if med is None else round(med * 1e4, 1), f"n={nb})", "usable5m", len(r5), "excl", ex5)

    names = list(POOLS)
    CORE = [n for n in POOLS if not n.startswith("SPY")]     # SPYon needs a basis correction -> lower confidence
    def run(RECS, **kw): return {nm: simulate(RECS[nm], SIG[POOLS[nm]["stock"]], **kw) for nm in names}
    def pooled(per): return summarize(pool_totals(list(per.values())))
    def entry(per): return dict(pooled=pooled(per), pooled_core=summarize(pool_totals([per[n] for n in CORE])), per_pool={nm: summarize(per[nm]) for nm in names})
    # ---- baseline (the pitch config): f0 = pool's own fee, K=.5, sigma x1, 300s cadence
    base = run(REC5)
    for nm in names: res["pools"][nm]["baseline"] = summarize(base[nm])
    res["pooled_baseline"] = pooled(base); res["pooled_core_baseline"] = summarize(pool_totals([base[n] for n in CORE]))
    # ---- sensitivity
    S_ = res["sens"]
    S_["f0_variants"] = {}
    for lab, f0 in (("pool's own fee", None), ("10 bps", 0.001), ("5 bps", 0.0005)):
        per = run(REC5, f0=f0); S_["f0_variants"][lab] = entry(per)
    S_["k_sweep"] = {str(k): entry(run(REC5, k=k)) for k in (0.25, 0.5, 0.75, 1.0)}
    S_["sigma_mult_5m"] = {str(m): entry(run(REC5, sigm=m)) for m in (0.0, 0.5, 1.0, 2.0)}
    # cadence study: identical 28-day window and identical swaps (intersection of swaps usable under BOTH references)
    S_["cadence_28d"] = {}
    ids1 = {nm: {c["id"] for c in REC1[nm]} for nm in names}; ids5 = {nm: {c["id"] for c in REC5[nm]} for nm in names}
    common = {nm: ids1[nm] & ids5[nm] for nm in names}
    sub5 = {nm: [c for c in REC5[nm] if c["id"] in common[nm]] for nm in names}
    sub1 = {nm: [c for c in REC1[nm] if c["id"] in common[nm]] for nm in names}
    for lab, RECS in (("300s (5m bars)", sub5), ("60s (1m bars)", sub1)):
        S_["cadence_28d"][lab] = {}
        for m in (0.0, 0.5, 1.0, 2.0):
            per = {nm: simulate(RECS[nm], SIG[POOLS[nm]["stock"]], sigm=m) for nm in names}
            S_["cadence_28d"][lab][str(m)] = entry(per)
    S_["fee_cap_sweep"] = {lab: entry(run(REC5, fmax=c)) for lab, c in (("cap 1%", 0.01), ("cap 2% (default)", 0.02), ("cap 5%", 0.05), ("no cap (25%)", 0.25))}
    S_["chunking_adversary"] = {str(n): entry(run(REC5, n=n)) for n in (1, 4, 16, 64)}
    S_["elasticity_remove"] = {str(x): entry(run(REC5, x=x)) for x in (0.0, 0.25, 0.5, 1.0)}
    S_["elasticity_fees_only_pessimistic"] = {str(x): entry(run(REC5, x=x, mode="fees_only")) for x in (0.0, 0.25, 0.5, 1.0)}
    S_["elasticity_chunk16_fees_only"] = {str(x): entry(run(REC5, x=x, n=16, mode="fees_only")) for x in (0.0, 0.5, 1.0)}
    if REC5_raw:
        S_["spy_basis_effect"] = {}
        for nm in REC5_raw:
            S_["spy_basis_effect"][nm] = dict(corrected=summarize(simulate(REC5[nm], SIG[POOLS[nm]["stock"]])),
                                              uncorrected=summarize(simulate(REC5_raw[nm], SIG[POOLS[nm]["stock"]])))
    json.dump(res, open("results.json", "w"), indent=1)
    print("wrote results.json")
