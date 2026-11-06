# DeviationFee backtest: results

Rule replayed: `fee = clamp(max(f0, 0.5 * d_eff), 2%)` if the swap moves the pool toward the reference price, else `f0`;
`d = |pool/ref - 1|`, `d_eff = max(0, d - sigma*sqrt(age))`, `f0` = the pool's own fee. Reference = stock price (Yahoo bars incl. pre/post market),
published at every bar start (no look-ahead). Fail-open to `f0` when no reference within one cadence (session closed/stale).
Static replay: observed swaps are held fixed and only the fee changes. "LP P&L" = LP gain on the replayed swaps (fees + adverse selection) marked at the reference price.
Reproduce: `python3 -I fetch_swaps.py && python3 -I fetch_prices.py && python3 -I analyze.py && python3 -I make_report.py` (scripts in this folder; numbers in `results.json`).

## 1. Headline (60 days, Ethereum Ondo-token pools, 5-minute reference)

| | swaps | volume | swaps surcharged | volume surcharged | swaps < $1k surcharged | avg surcharge (bps) | LP P&L change |
|---|---|---|---|---|---|---|---|
| NVDAon_v3_0.3 | 12,805 | $5,220,941 | 1.62% | 6.9% | 142/11751 (1.21%) | 13.9 | $1,481 (+8.22%) |
| NVDAon_v4 | 6,072 | $2,032,750 | 0.76% | 2.8% | 30/5628 (0.53%) | 31.0 | $128 (+1.3%) |
| TSLAon_v3_1 | 3,981 | $1,452,813 | 2.84% | 3.94% | 103/3695 (2.79%) | 78.4 | $460 (+4.71%) |
| SPYon_v3_0.3 | 3,663 | $1,095,502 | 4.37% | 11.28% | 121/3465 (3.49%) | 22.6 | $268 (+7.49%) |
| **core 3 (no SPYon)** | 22,858 | $8,706,504 | 1.6% | 5.45% | 275/21074 (1.3%) | 36.0 | $2,069 (+5.5%) |
| all 4 | 26,521 | $9,802,006 | 1.98% | 6.1% | 396/24539 (1.61%) | 31.9 | $2,337 (+5.67%) |

- Non-arbitrage-direction swaps surcharged: **0** (by construction). Surcharged swaps whose execution would be worse than the reference price after the fee: **0**.
- Surcharge is concentrated: the top 10 swaps carry **70.3%** of the extra fee on the core 3 pools (largest single swap $699); NVDAon v3 alone is $1,481 of $2,069.
- Average extra fee over *all* volume is only **2.38 bps**.
- Honest size: **$2,069 over 60 days on $8,706,504 of volume (+5.5% of LP P&L)**. This is a protective rule, not a profit engine. The LPs in these pools were already net positive (fees 30-100 bps cover the arbitrage loss).

## 2. Robustness (core 3 pools, pooled; static replay)

| scenario (core 3 pools) | LP P&L change | swaps surcharged | swaps < $1k surcharged | fair-price violations |
|---|---|---|---|---|
| **baseline** (k=0.5, sigma x1, cap 2%, 300s) | $2,069 (+5.5%) | 1.6% | 1.3% | 0 |
| chunking adversary n=4 | $1,528 (+4.06%) | 1.6% | 1.3% | 0 |
| chunking adversary n=16 | $1,370 (+3.64%) | 1.6% | 1.3% | 0 |
| chunking adversary n=64 | $1,329 (+3.53%) | 1.6% | 1.3% | 0 |
| k = 0.25 | $965 (+2.56%) | 0.49% | 0.42% | 0 |
| k = 0.75 | $3,799 (+10.09%) | 6.3% | 5.53% | 0 |
| k = 1.0 | $6,615 (+17.58%) | 14.76% | 13.72% | 5 |
| sigma multiple 0 | $2,283 (+6.07%) | 2.25% | 1.82% | 0 |
| sigma multiple 0.5 | $2,168 (+5.76%) | 1.87% | 1.51% | 0 |
| sigma multiple 2 | $1,921 (+5.11%) | 1.22% | 1.01% | 0 |
| fee cap 1% | $1,069 (+2.84%) | 1.11% | 0.82% | 0 |
| fee cap 5% | $3,271 (+8.69%) | 1.6% | 1.3% | 0 |
| no fee cap (25%) | $3,762 (+10.0%) | 1.6% | 1.3% | 0 |
| base fee lowered to 10 bps | -$24,485 (-65.06%) | 33.45% | 32.23% | 0 |
| base fee lowered to 5 bps | -$26,867 (-71.39%) | 40.9% | 39.61% | 0 |
| elasticity: 25% of surcharged volume lost (fees lost, adverse selection kept) | $1,053 (+2.8%) | 1.6% | 1.3% | 0 |
| elasticity: 50% lost (same, pessimistic) | $37 (+0.1%) | 1.6% | 1.3% | 0 |
| elasticity: 100% lost (same, pessimistic) | -$1,996 (-5.3%) | 1.6% | 1.3% | 0 |
| elasticity: 50% lost, lost swaps vanish entirely (optimistic) | $4,001 (+10.63%) | 1.6% | 1.3% | 0 |
| chunk n=16 AND 50% lost (pessimistic) | -$313 (-0.83%) | 1.6% | 1.3% | 0 |

### Reference cadence (same 28 days, same swaps, core 3, sigma x1)
| cadence | LP P&L change | swaps surcharged | swaps < $1k surcharged | baseline LP P&L on these swaps |
|---|---|---|---|---|
| 300 s (5m bars) | $1,323 (+10.28%) | 2.74% | 2.1% | $12,872 |
| 60 s (1m bars) | $1,479 (+15.71%) | 5.57% | 4.19% | $9,412 |

## 3. What the numbers say
- **Normal users:** about 1.3% of sub-$1k swaps (275 of 21,074) pay a surcharge, always on the arbitrage side, and never more than half the deviation. A 60s reference roughly doubles the share touched (4.19% vs 2.1%) because the deadband shrinks and more deviations are detected.
- **k is not the knob:** k=0.5 comes from the revenue-maximisation derivation, not from this replay. The static P&L rises with k (k=1.0: $6,615), but only because the replay assumes arbitrageurs do not react; k=1.0 also surcharges 14.76% of swaps and produces 5 fair-price violations. The backtest cannot validate k; the derivation pins it.
- **sigma multiple barely matters** (Delta $1,921 at x2 vs $2,283 at x0), so the noise deadband is not a sensitive parameter.
- **Chunking adversary** (arb splits each swap into 16 pieces, fee on the running deviation) keeps 66% of the static gain ($1,370), consistent with the derivation's ~50%-of-loss lower bound for large deviations.
- **Volume elasticity:** in the pessimistic case (surcharged swaps leave, but the adverse selection they carried is still suffered elsewhere) the gain disappears once about **51%** of surcharged volume is lost (41% if the arb also chunks). Only ~5.45% of volume is surcharged. If lost swaps vanish entirely (optimistic), P&L improves, because those swaps were net losers for the LP.
- **Lowering the base fee does not pay** under constant volume (-$24,485 at 10 bps): the surcharge recovers far less than the fee income given up on ordinary flow. Needs a large volume uplift (unmeasured) to work.
- **The fee cap matters:** uncapped, the gain would be $3,762, but that comes from a few swaps where the pool was >4% off the reference (fee up to 12%). The 2% cap removes $1,692 of paper gain. Treat uncapped numbers as unrealistic.

## 4. SPYon problem: fixed and documented
- **Overflow bug:** 15 SPYon swaps (and 35 TSLAon) leave the pool price pinned at the tick bound (3.4e50 or 1e-27) when liquidity is exhausted. The next swap's pre-price was absurd, d ~ 1e50, fee = d/2 ~ 1e49, surcharge x volume overflowed. Fix: exclude swaps whose pre-price is >25% from the reference ("pool dislocated"; 4 per pool inside the window) plus a hard fee cap of 2%.
- **Persistent offset:** SPYon trades ~+91.4 bps above SPY (median, 45 days before the window), 3x its 30 bps fee band. Not a dividend/share-multiplier effect: no persistent step at ex-dividend dates (`spy_investigation.txt`); cause unidentified.
- **Treatment:** an out-of-sample constant basis (91.4 bps, estimated on the 45 days *before* the window, applied only if >2x the pool fee) is applied to SPYon's reference. Without it the rule would surcharge 40.73% of swaps (39.6% of small ones) for a spurious $1,652. With it: 4.37% of swaps and $268. SPYon is **excluded from the headline "core 3"** as lower confidence.

## 5. Corrections to numbers quoted earlier in the conversation
The first prototype reported +11% (NVDAon v3), +1.6% (v4) and +20% (TSLAon). Superseded. This harness reproduces the prototype exactly when the fee cap and the dislocation filter are switched off (+$2,003 / +11.1%, +$161 / +1.6%, +$1,922 / +19.8%): the prototype had no cap, so a handful of mispriced swaps paid fees up to ~12%. With the 2% cap the figures are NVDAon v3 +8.22%, v4 +1.3%, TSLAon +4.71%. Allowing references up to 10 minutes old inflated NVDAon v3 to +22.6% (stale references make the replay self-confirming: the "fair" price is stale too). Strict age = one cadence is used throughout.

## 6. Caveats
- **Static replay:** real arbitrageurs react (chunk, reroute, stop). Scenarios above bracket this but do not model it.
- **Reference quality:** Yahoo bar opens stand in for the oracle; the real CRE feed will differ. Yahoo is unofficial and may rate-limit or change. 1m bars exist only for ~28 days, so the 60s study covers 28 days, not 60.
- **Baseline P&L depends on the fair-price benchmark:** a 60s reference exposes more adverse selection (baseline P&L on the same swaps falls from $12,872 to $9,412), so percentage gains are not comparable across cadences; compare dollars.
- **Window:** 60 days, one regime, 3 liquid pools; NVDAon v3 dominates the gain (86.0% of its extra fee is in 10 swaps). Small samples: do not read the decimals.
- **Dividends/splits ignored** except the SPYon basis; block timestamps are interpolated from anchors (error seconds); notional filter 1 to $2M; "small swap" = < $1k is a retail proxy, not an identity.
- **Weekend/closed hours are not modelled:** no reference exists, the hook fails open.
- LP P&L covers trades only (not impermanent-loss of a passive position or in-range positioning).
- Excluded swaps: 38,679 had no fresh reference (market closed/stale), 1205 outside the size filter, 8 dislocated pool states.

## Files
`config.py` (pools, constants), `fetch_swaps.py`, `fetch_prices.py`, `analyze.py` (rule + sensitivities), `make_report.py`, `investigate_spy.py` -> `spy_investigation.txt`, `results.json` (for the dashboard), `data/` (swap logs are symlinks to the scratchpad copies; re-fetchable with `fetch_swaps.py`).
