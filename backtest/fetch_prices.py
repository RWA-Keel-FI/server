"""Download Yahoo Finance bars incl. pre/post market (unofficial API; cache a copy for demos).
 1h (2y), 5m (60d), 1m (last ~28d, fetched in 7-day chunks). Output: data/px_{TICKER}_{1h,5m,1m}.json = {ts,open,close}, + dividends.
"""
import json, os, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import *
os.makedirs(DATA, exist_ok=True)
def get(u):
    for i in range(4):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=40))["chart"]["result"][0]
        except Exception as e: err = e; time.sleep(2)
    raise err
def rows(r):
    q = r["indicators"]["quote"][0]
    return [(a, o, c) for a, o, c in zip(r["timestamp"], q["open"], q["close"]) if o is not None and c is not None]
now = int(time.time())
for t in TICKERS:
    # 1h
    r = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{t}?interval=1h&range=2y&includePrePost=true&events=div")
    R = rows(r); divs = {k: v["amount"] for k, v in r.get("events", {}).get("dividends", {}).items()}
    json.dump(dict(ts=[x[0] for x in R], open=[x[1] for x in R], close=[x[2] for x in R], dividends=divs), open(f"{DATA}/px_{t}_1h.json", "w"))
    # 5m
    R = rows(get(f"https://query1.finance.yahoo.com/v8/finance/chart/{t}?interval=5m&range=60d&includePrePost=true"))
    json.dump(dict(ts=[x[0] for x in R], open=[x[1] for x in R], close=[x[2] for x in R]), open(f"{DATA}/px_{t}_5m.json", "w"))
    # 1m in 7-day chunks
    allr = {}
    for k in range(4):
        p2 = now - k * 7 * 86400; p1 = p2 - 7 * 86400 + 3600
        for x in rows(get(f"https://query1.finance.yahoo.com/v8/finance/chart/{t}?interval=1m&period1={p1}&period2={p2}&includePrePost=true")): allr[x[0]] = x
    R = [allr[k] for k in sorted(allr)]
    json.dump(dict(ts=[x[0] for x in R], open=[x[1] for x in R], close=[x[2] for x in R]), open(f"{DATA}/px_{t}_1m.json", "w"))
    print(t, "1h/5m/1m bars fetched; 1m rows:", len(R))
