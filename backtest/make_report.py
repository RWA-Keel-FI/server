"""Render RESULTS.md from results.json (numbers are pulled, not typed). usage: python3 -I make_report.py"""
import json
r = json.load(open("results.json")); S = r["sens"]; m = r["meta"]
core, allp = r["pooled_core_baseline"], r["pooled_baseline"]
def usd(x): return f"${x:,.0f}" if x >= 0 else f"-${-x:,.0f}"
def row(lab, s):
    return f"| {lab} | {s['swaps']:,} | {usd(s['volume'])} | {s['pct_swaps_surcharged']}% | {s['pct_volume_surcharged']}% | {s['n_small_sur']}/{s['n_small']} ({s['pct_small_swaps_surcharged']}%) | {s['avg_surcharge_bps']} | {usd(s['delta_pnl'])} ({s['delta_pct']:+}%) |"
H = "| | swaps | volume | swaps surcharged | volume surcharged | swaps < $1k surcharged | avg surcharge (bps) | LP P&L change |\n|---|---|---|---|---|---|---|---|"
def rb(lab, e, key="pooled_core"):
    s = e[key]; return f"| {lab} | {usd(s['delta_pnl'])} ({s['delta_pct']:+}%) | {s['pct_swaps_surcharged']}% | {s['pct_small_swaps_surcharged']}% | {s['fair_price_violations']} |"
RH = "| scenario (core 3 pools) | LP P&L change | swaps surcharged | swaps < $1k surcharged | fair-price violations |\n|---|---|---|---|---|"
fo = S["elasticity_fees_only_pessimistic"]; d0, d1 = fo["0.0"]["pooled_core"]["delta_pnl"], fo["1.0"]["pooled_core"]["delta_pnl"]
be = d0 / (d0 - d1)
fc = S["elasticity_chunk16_fees_only"]; e0, e1 = fc["0.0"]["pooled_core"]["delta_pnl"], fc["1.0"]["pooled_core"]["delta_pnl"]; be16 = e0 / (e0 - e1)
cad = S["cadence_28d"]; c300, c60 = cad["300s (5m bars)"]["1.0"]["pooled_core"], cad["60s (1m bars)"]["1.0"]["pooled_core"]
P = r["pools"]; spy = S["spy_basis_effect"]["SPYon_v3_0.3"]
out = f"""# DeviationFee backtest: results

Rule replayed: `fee = clamp(max(f0, 0.5 * d_eff), 2%)` if the swap moves the pool toward the reference price, else `f0`;
`d = |pool/ref - 1|`, `d_eff = max(0, d - sigma*sqrt(age))`, `f0` = the pool's own fee. Reference = stock price (Yahoo bars incl. pre/post market),
published at every bar start (no look-ahead). Fail-open to `f0` when no reference within one cadence (session closed/stale).
Static replay: observed swaps are held fixed and only the fee changes. "LP P&L" = LP gain on the replayed swaps (fees + adverse selection) marked at the reference price.
Reproduce: `python3 -I fetch_swaps.py && python3 -I fetch_prices.py && python3 -I analyze.py && python3 -I make_report.py` (scripts in this folder; numbers in `results.json`).

## 1. Headline (60 days, Ethereum Ondo-token pools, 5-minute reference)

{H}
""" + "\n".join([row(n, P[n]["baseline"]) for n in P]) + f"""
{row("**core 3 (no SPYon)**", core)}
{row("all 4", allp)}

- Non-arbitrage-direction swaps surcharged: **0** (by construction). Surcharged swaps whose execution would be worse than the reference price after the fee: **0**.
- Surcharge is concentrated: the top 10 swaps carry **{core['top10_share_of_extra_fee_pct']}%** of the extra fee on the core 3 pools (largest single swap {usd(core['largest_single_extra_fee_usd'])}); NVDAon v3 alone is {usd(P['NVDAon_v3_0.3']['baseline']['extra_fee_usd'])} of {usd(core['extra_fee_usd'])}.
- Average extra fee over *all* volume is only **{core['avg_extra_bps_all_volume']} bps**.
- Honest size: **{usd(core['delta_pnl'])} over 60 days on {usd(core['volume'])} of volume (+{core['delta_pct']}% of LP P&L)**. This is a protective rule, not a profit engine. The LPs in these pools were already net positive (fees 30-100 bps cover the arbitrage loss).

## 2. Robustness (core 3 pools, pooled; static replay)

{RH}
{rb("**baseline** (k=0.5, sigma x1, cap 2%, 300s)", {"pooled_core": core})}
{rb("chunking adversary n=4", S["chunking_adversary"]["4"])}
{rb("chunking adversary n=16", S["chunking_adversary"]["16"])}
{rb("chunking adversary n=64", S["chunking_adversary"]["64"])}
{rb("k = 0.25", S["k_sweep"]["0.25"])}
{rb("k = 0.75", S["k_sweep"]["0.75"])}
{rb("k = 1.0", S["k_sweep"]["1.0"])}
{rb("sigma multiple 0", S["sigma_mult_5m"]["0.0"])}
{rb("sigma multiple 0.5", S["sigma_mult_5m"]["0.5"])}
{rb("sigma multiple 2", S["sigma_mult_5m"]["2.0"])}
{rb("fee cap 1%", S["fee_cap_sweep"]["cap 1%"])}
{rb("fee cap 5%", S["fee_cap_sweep"]["cap 5%"])}
{rb("no fee cap (25%)", S["fee_cap_sweep"]["no cap (25%)"])}
{rb("base fee lowered to 10 bps", S["f0_variants"]["10 bps"])}
{rb("base fee lowered to 5 bps", S["f0_variants"]["5 bps"])}
{rb("elasticity: 25% of surcharged volume lost (fees lost, adverse selection kept)", S["elasticity_fees_only_pessimistic"]["0.25"])}
{rb("elasticity: 50% lost (same, pessimistic)", S["elasticity_fees_only_pessimistic"]["0.5"])}
{rb("elasticity: 100% lost (same, pessimistic)", S["elasticity_fees_only_pessimistic"]["1.0"])}
{rb("elasticity: 50% lost, lost swaps vanish entirely (optimistic)", S["elasticity_remove"]["0.5"])}
{rb("chunk n=16 AND 50% lost (pessimistic)", S["elasticity_chunk16_fees_only"]["0.5"])}

### Reference cadence (same 28 days, same swaps, core 3, sigma x1)
| cadence | LP P&L change | swaps surcharged | swaps < $1k surcharged | baseline LP P&L on these swaps |
|---|---|---|---|---|
| 300 s (5m bars) | {usd(c300['delta_pnl'])} ({c300['delta_pct']:+}%) | {c300['pct_swaps_surcharged']}% | {c300['pct_small_swaps_surcharged']}% | {usd(c300['base_pnl'])} |
| 60 s (1m bars) | {usd(c60['delta_pnl'])} ({c60['delta_pct']:+}%) | {c60['pct_swaps_surcharged']}% | {c60['pct_small_swaps_surcharged']}% | {usd(c60['base_pnl'])} |

## 3. What the numbers say
- **Normal users:** about {core['pct_small_swaps_surcharged']}% of sub-$1k swaps ({core['n_small_sur']} of {core['n_small']:,}) pay a surcharge, always on the arbitrage side, and never more than half the deviation. A 60s reference roughly doubles the share touched ({c60['pct_small_swaps_surcharged']}% vs {c300['pct_small_swaps_surcharged']}%) because the deadband shrinks and more deviations are detected.
- **k is not the knob:** k=0.5 comes from the revenue-maximisation derivation, not from this replay. The static P&L rises with k (k=1.0: {usd(S['k_sweep']['1.0']['pooled_core']['delta_pnl'])}), but only because the replay assumes arbitrageurs do not react; k=1.0 also surcharges {S['k_sweep']['1.0']['pooled_core']['pct_swaps_surcharged']}% of swaps and produces {S['k_sweep']['1.0']['pooled_core']['fair_price_violations']} fair-price violations. The backtest cannot validate k; the derivation pins it.
- **sigma multiple barely matters** (Delta {usd(S['sigma_mult_5m']['2.0']['pooled_core']['delta_pnl'])} at x2 vs {usd(S['sigma_mult_5m']['0.0']['pooled_core']['delta_pnl'])} at x0), so the noise deadband is not a sensitive parameter.
- **Chunking adversary** (arb splits each swap into 16 pieces, fee on the running deviation) keeps {S['chunking_adversary']['16']['pooled_core']['delta_pnl']/core['delta_pnl']*100:.0f}% of the static gain ({usd(S['chunking_adversary']['16']['pooled_core']['delta_pnl'])}), consistent with the derivation's ~50%-of-loss lower bound for large deviations.
- **Volume elasticity:** in the pessimistic case (surcharged swaps leave, but the adverse selection they carried is still suffered elsewhere) the gain disappears once about **{be*100:.0f}%** of surcharged volume is lost ({be16*100:.0f}% if the arb also chunks). Only ~{core['pct_volume_surcharged']}% of volume is surcharged. If lost swaps vanish entirely (optimistic), P&L improves, because those swaps were net losers for the LP.
- **Lowering the base fee does not pay** under constant volume ({usd(S['f0_variants']['10 bps']['pooled_core']['delta_pnl'])} at 10 bps): the surcharge recovers far less than the fee income given up on ordinary flow. Needs a large volume uplift (unmeasured) to work.
- **The fee cap matters:** uncapped, the gain would be {usd(S['fee_cap_sweep']['no cap (25%)']['pooled_core']['delta_pnl'])}, but that comes from a few swaps where the pool was >4% off the reference (fee up to 12%). The 2% cap removes {usd(S['fee_cap_sweep']['no cap (25%)']['pooled_core']['delta_pnl']-core['delta_pnl'])} of paper gain. Treat uncapped numbers as unrealistic.

## 4. SPYon problem: fixed and documented
- **Overflow bug:** {P['SPYon_v3_0.3']['absurd_pool_prices_all_time']} SPYon swaps (and {P['TSLAon_v3_1']['absurd_pool_prices_all_time']} TSLAon) leave the pool price pinned at the tick bound (3.4e50 or 1e-27) when liquidity is exhausted. The next swap's pre-price was absurd, d ~ 1e50, fee = d/2 ~ 1e49, surcharge x volume overflowed. Fix: exclude swaps whose pre-price is >25% from the reference ("pool dislocated"; 4 per pool inside the window) plus a hard fee cap of 2%.
- **Persistent offset:** SPYon trades ~+{P['SPYon_v3_0.3']['basis_median_oos_bps']} bps above SPY (median, 45 days before the window), 3x its 30 bps fee band. Not a dividend/share-multiplier effect: no persistent step at ex-dividend dates (`spy_investigation.txt`); cause unidentified.
- **Treatment:** an out-of-sample constant basis ({P['SPYon_v3_0.3']['basis_applied_bps']} bps, estimated on the 45 days *before* the window, applied only if >2x the pool fee) is applied to SPYon's reference. Without it the rule would surcharge {spy['uncorrected']['pct_swaps_surcharged']}% of swaps ({spy['uncorrected']['pct_small_swaps_surcharged']}% of small ones) for a spurious {usd(spy['uncorrected']['delta_pnl'])}. With it: {spy['corrected']['pct_swaps_surcharged']}% of swaps and {usd(spy['corrected']['delta_pnl'])}. SPYon is **excluded from the headline "core 3"** as lower confidence.

## 5. Corrections to numbers quoted earlier in the conversation
The first prototype reported +11% (NVDAon v3), +1.6% (v4) and +20% (TSLAon). Superseded. This harness reproduces the prototype exactly when the fee cap and the dislocation filter are switched off (+$2,003 / +11.1%, +$161 / +1.6%, +$1,922 / +19.8%): the prototype had no cap, so a handful of mispriced swaps paid fees up to ~12%. With the 2% cap the figures are NVDAon v3 {P['NVDAon_v3_0.3']['baseline']['delta_pct']:+}%, v4 {P['NVDAon_v4']['baseline']['delta_pct']:+}%, TSLAon {P['TSLAon_v3_1']['baseline']['delta_pct']:+}%. Allowing references up to 10 minutes old inflated NVDAon v3 to +22.6% (stale references make the replay self-confirming: the "fair" price is stale too). Strict age = one cadence is used throughout.

## 6. Caveats
- **Static replay:** real arbitrageurs react (chunk, reroute, stop). Scenarios above bracket this but do not model it.
- **Reference quality:** Yahoo bar opens stand in for the oracle; the real CRE feed will differ. Yahoo is unofficial and may rate-limit or change. 1m bars exist only for ~28 days, so the 60s study covers 28 days, not 60.
- **Baseline P&L depends on the fair-price benchmark:** a 60s reference exposes more adverse selection (baseline P&L on the same swaps falls from {usd(c300['base_pnl'])} to {usd(c60['base_pnl'])}), so percentage gains are not comparable across cadences; compare dollars.
- **Window:** 60 days, one regime, 3 liquid pools; NVDAon v3 dominates the gain ({P['NVDAon_v3_0.3']['baseline']['top10_share_of_extra_fee_pct']}% of its extra fee is in 10 swaps). Small samples: do not read the decimals.
- **Dividends/splits ignored** except the SPYon basis; block timestamps are interpolated from anchors (error seconds); notional filter 1 to $2M; "small swap" = < $1k is a retail proxy, not an identity.
- **Weekend/closed hours are not modelled:** no reference exists, the hook fails open.
- LP P&L covers trades only (not impermanent-loss of a passive position or in-range positioning).
- Excluded swaps: {sum(P[n]['excluded_5m'].get('no_reference(closed/stale)',0) for n in P):,} had no fresh reference (market closed/stale), {sum(P[n]['excluded_5m'].get('size',0) for n in P)} outside the size filter, {sum(P[n]['excluded_5m'].get('pool_dislocated(>25%)',0) for n in P)} dislocated pool states.

## Files
`config.py` (pools, constants), `fetch_swaps.py`, `fetch_prices.py`, `analyze.py` (rule + sensitivities), `make_report.py`, `investigate_spy.py` -> `spy_investigation.txt`, `results.json` (for the dashboard), `data/` (swap logs are symlinks to the scratchpad copies; re-fetchable with `fetch_swaps.py`).
"""
open("RESULTS.md", "w").write(out); print("wrote RESULTS.md", len(out))
