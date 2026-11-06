"""Fetch Swap logs for the configured pools via public RPC eth_getLogs (read-only).
usage: python3 -I fetch_swaps.py [--link-from DIR] [--force]
 --link-from DIR : symlink already-downloaded logs_*.json / anchors.json from DIR instead of refetching
"""
import json, os, sys, time, urllib.request, argparse
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import *

ap = argparse.ArgumentParser(); ap.add_argument("--link-from"); ap.add_argument("--force", action="store_true")
args = ap.parse_args(); os.makedirs(DATA, exist_ok=True)

def rpc(method, params, tries=8):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(RPCS[i % len(RPCS)], data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                         headers={"content-type": "application/json", "User-Agent": "deviationfee-backtest"})
            d = json.load(urllib.request.urlopen(req, timeout=60))
            if "error" in d: last = d["error"]; time.sleep(1.5); continue
            return d["result"]
        except Exception as e:
            last = e; time.sleep(1.5)
    raise RuntimeError(str(last))

if args.link_from:
    for fn in os.listdir(args.link_from):
        if (fn.startswith("logs_") or fn == "anchors.json") and not os.path.exists(os.path.join(DATA, fn)):
            os.symlink(os.path.join(args.link_from, fn), os.path.join(DATA, fn))
    print("linked existing files from", args.link_from)

anch_path = os.path.join(DATA, "anchors.json")
head = int(rpc("eth_blockNumber", []), 16)
if args.force or not os.path.exists(anch_path):
    def anchor(b):
        r = rpc("eth_getBlockByNumber", [hex(b), False]); return (b, int(r["timestamp"], 16))
    bl = list(range(head - 100000 * 35, head, 100000))
    with ThreadPoolExecutor(6) as ex: anchors = sorted(ex.map(anchor, bl)) + [anchor(head)]
    json.dump(anchors, open(anch_path, "w"))
anchors = json.load(open(anch_path))

def ts_to_block(ts):
    for (b0, t0), (b1, t1) in zip(anchors, anchors[1:]):
        if t0 <= ts <= t1: return int(b0 + (ts - t0) * (b1 - b0) / (t1 - t0))
    return anchors[0][0]

def fetch_pool(name):
    out_path = os.path.join(DATA, f"logs_{name}.json")
    if os.path.exists(out_path) and not args.force: print(name, "cached"); return
    p = POOLS[name]
    frm = max(ts_to_block(time.mktime(time.strptime(p["start"], "%Y-%m-%d"))) - 20000, anchors[0][0]); out = []
    while frm <= head:
        to = min(frm + 39999, head)
        if p["kind"] == "v3": flt = {"address": p["addr"], "fromBlock": hex(frm), "toBlock": hex(to), "topics": [V3_SWAP]}
        else: flt = {"address": V4_POOL_MANAGER, "fromBlock": hex(frm), "toBlock": hex(to), "topics": [V4_SWAP, p["addr"]]}
        for l in rpc("eth_getLogs", [flt]):
            out.append(dict(b=int(l["blockNumber"], 16), data=l["data"], tx=l["transactionHash"], i=int(l["logIndex"], 16)))
        frm = to + 1
    json.dump(out, open(out_path, "w")); print(name, len(out))

with ThreadPoolExecutor(3) as ex: list(ex.map(fetch_pool, POOLS))
