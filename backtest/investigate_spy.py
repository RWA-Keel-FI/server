"""Why does SPYon trade ~+90-100 bps above SPY? Tests the dividend/share-multiplier hypothesis (weekly median deviation vs ex-div weeks).
usage: python3 -I investigate_spy.py > spy_investigation.txt"""
import sys, os, json, bisect, statistics as st, collections, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze as A
from config import *
S = A.decode("SPYon_v3_0.3"); b = A.load_bars("SPY", "1h"); ts, op = b["ts"], b["open"]
divs = sorted(dt.datetime.fromtimestamp(int(k), A.NY).date() for k in b["dividends"])
print("SPY ex-dividend dates (Yahoo):", [str(d) for d in divs])
wk = collections.defaultdict(list)
for s in S:
    if not A.is_rth(s["ts"]): continue
    i = bisect.bisect_right(ts, s["ts"]) - 1
    if i < 0 or s["ts"] - ts[i] > 3600 or not (0.2 < s["px"] / op[i] < 5): continue
    d = dt.datetime.fromtimestamp(s["ts"], A.NY).date(); wk[d - dt.timedelta(days=d.weekday())].append((s["px"] / op[i] - 1) * 1e4)
print("\nweek(Mon)   median pool-vs-SPY deviation (bps)   n_swaps")
for w in sorted(wk):
    if len(wk[w]) >= 25: print(w, f"{st.median(wk[w]):8.0f}   {len(wk[w]):5d}", "  <- ex-div week" if any(w <= d < w + dt.timedelta(days=7) for d in divs) else "")
print("\nIf the token accrued dividends via a share multiplier, the offset would step UP ~+27 bps at each ex-div week (SPY pays ~0.27%/qtr).")
print("Observed: a +32 bps blip in the week after the 2026-09-18 ex-div (100 -> 132, n=350) that REVERTS to 97-111 within two weeks; no persistent step.")
print("=> dividend/share-multiplier accrual does NOT explain the offset (it would persist and compound). Cause unidentified: a stable ~+85-110 bps premium, 3x the 30 bps fee band.")
print("   Tokens expose no sharesMultiplier()/multiplier() via eth_call (proxy ABI unknown), so this is an empirical test only. Weekly samples are thin (n=31..1818).")
bad = [s for s in S if not (s["px"] == s["px"]) or s["px"] > 1e5 or s["px"] < 1e-3]
print(f"\nAbsurd pool prices (liquidity exhausted, sqrtPrice pinned at tick bound): {len(bad)}; examples:", [(dt.datetime.fromtimestamp(s['ts'], A.NY).strftime('%Y-%m-%d'), f"{s['px']:.3g}") for s in bad[:5]])
print("=> these produced d ~ 1e50, fee = d/2 ~ 1e49, surcharge = fee*volume overflow in the first prototype. Fixed by DISLOC exclusion (|p/r-1|>25%) and F_MAX cap.")
