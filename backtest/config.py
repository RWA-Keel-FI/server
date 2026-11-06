"""Shared configuration for the DeviationFee backtest (read-only research, no keys, no txs)."""
import os
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

# Public RPCs that allow wide eth_getLogs ranges (checked 2026-11-07). Order = preference.
RPCS = ["https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io"]

V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
V4_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
V4_POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90"

# usdc0 = True  -> token0 is USDC (6 dec), token1 is the Ondo stock token (18 dec)
# fee   = pool fee tier (v3). v4 reads the per-swap fee from the event.
POOLS = {
    "NVDAon_v3_0.3": dict(kind="v3", addr="0xc9b4bC7C15423FCFe6B75aB5118bA773945A3A46", stock="NVDA", usdc0=False, fee=0.003, start="2026-03-27"),
    "NVDAon_v4":     dict(kind="v4", addr="0xa9a6651fba74df1aab94065ffaabe750d6ed835b94a9e28925ec79beec2d5f73", stock="NVDA", usdc0=False, fee=None, start="2026-09-07"),
    "TSLAon_v3_1":   dict(kind="v3", addr="0x31227b50eCCDC9C589826AA2D9E7C5619B1895Da", stock="TSLA", usdc0=True,  fee=0.01,  start="2025-09-16"),
    "SPYon_v3_0.3":  dict(kind="v3", addr="0x5638bbDE046EC2EFC7C8f3fd8DC5A9A1016f7EEB", stock="SPY",  usdc0=True,  fee=0.003, start="2025-09-05"),
}
TICKERS = ["NVDA", "TSLA", "SPY"]

# ---- rule constants -------------------------------------------------------
K = 0.5               # derived: revenue-maximising surcharge share of deviation (f* = d/2)
SIGMA_MULT = 1.0      # deadband multiple of staleness noise sigma*sqrt(age)
F_MAX = 0.02          # hard cap on any single-swap fee (hook-level safety cap)
STALE_S = 900         # reference older than this (or no bar) -> fail-open to base fee f0
DISLOC = 0.25         # |pool/ref - 1| above this -> pool dislocated (liquidity exhausted), excluded
MAX_NOTIONAL = 2_000_000
SMALL_USD = 1_000     # "normal user" proxy: swaps below this notional
