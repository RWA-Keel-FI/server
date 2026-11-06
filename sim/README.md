# sim: simulated market around the DeviationFee hook

Everything here is **simulated**. The tokens are mock test tokens, the USDC is mock USDC, and the arbitrageur, the retail users and the price feeder are bots written for this demo. Nothing touches a real chain: the code refuses any chain id except 31337 (local anvil) and any RPC that is not on localhost. Keys are anvil's public default test keys.

## What runs

One process, one clock, four parts. Each tick advances simulated time (anvil's block timestamp is set to it), so the hook's staleness checks and the oracle's timestamps follow the simulated clock.

| Part | File | What it does |
|---|---|---|
| feeder | `src/bots.ts` (`Feeder`) | Plays the Chainlink CRE workflow. While the US session is open it pushes each ticker's price to the oracle through `MockForwarder.deliver`. While closed it sends a zero-price heartbeat every 30 minutes, which the oracle ignores, exactly like the real workflow. Session logic is imported from `../cre/deviation-workflow/src/session.ts`. |
| price paths | `src/prices.ts` | The hidden "true" price of each stock. `replay`: real 5-minute bars from `../backtest/data/px_*_5m.json` (SPY, NVDA, TSLA); META, GOOGL, AAPL have no bars, so they follow a random walk correlated 0.6 with SPY's real returns. `walk`: random walk at the measured volatility. `--shock` adds a hidden news jump. |
| arb | `src/bots.ts` (`ArbBot`) | For both pools of every ticker, trades toward the oracle price when the edge beats fee plus a modeled gas cost, sized to the no-arb boundary `r/(1-f)` or `r(1-f)`. It asks the hook for the fee it will be charged (`quoteFee`) and keeps trading until no profit is left, so it can split a big move into several swaps. During a closed session in `weekend-gap` it also trades toward the hidden true price (an "informed" trader). |
| retail | `src/bots.ts` (`RetailBot`) | Random-size buys and sells (log-normal around $300, capped at $5,000). **The same order goes to the hook pool and to the control pool**, so the fee difference is a paired comparison. |
| lpwatch | `src/lpwatch.ts` | Every tick records each pool's price, deviation, fees and LP P&L to `out/metrics.jsonl`; at the end writes `out/summary.json` and `out/summary-<scenario>.json`. |

Two venues implement the same interface (`src/venue.ts`):

- `anvil` (`src/anvilVenue.ts`): swaps go through the deployed `SwapRouter` into the deployed v4 `PoolManager`; the hook pool uses the deployed `DeviationFeeHook`; reports go through `MockForwarder` into `RefPriceOracle`. Pool price and liquidity are read with `extsload`, fees from the v4 `Swap` event.
- `model` (`src/modelVenue.ts`): an in-memory constant-product pool that applies the hook's fee rule in floating point (`src/fee.ts`). It is **not** the contract. It exists to exercise the bots without a chain and as a cross-check.

## Run it

```
# 1. a local chain with the demo deployed (kills and restarts the anvil on 127.0.0.1:8545)
./fresh-chain.sh

# 2. a scenario on-chain
pnpm sim up --scenario calm
pnpm sim up --scenario volatile
pnpm sim up --scenario weekend-gap

# in-memory model instead (no chain needed)
pnpm sim up --scenario weekend-gap --venue model

# everything, each on a fresh chain (about 15 minutes)
./run-all.sh
```

Options: `--ticks N`, `--seed N`, `--shock NVDA:3@16` (a hidden +3% news jump 16 hours after the start; comma-separate several), `--arb-chunks N` (the arbitrageur splits each full-boundary trade into N pieces), `--tvl USD` (model venue), `--deployment <path>`, `--out <dir>`.

Tests: `pnpm test` (fee rule, arb sizing, price paths, oracle semantics, LP accounting, a full model run). `pnpm typecheck`.

## Scenarios

| Name | Window | Prices | What it shows |
|---|---|---|---|
| `calm` | Tuesday 10:00 NY, 4 hours, 60 s ticks | random walk at measured volatility | Ordinary trading: the hook rarely arms, retail pays the base fee. |
| `volatile` | same, 3x volatility plus two hidden news jumps (NVDA +2.5%, TSLA -3%) | random walk | Fast moves: the hook arms on the arbitrageur's trades. |
| `weekend-gap` | Friday 19:30 NY to Monday 13:00 NY, 15-minute ticks | replay of real bars from the latest weekend that stays in one DST regime | Session closes at 20:00, the oracle goes quiet, the hook fails open to the base fee, the oracle resumes Monday 04:00 and the real pre-market gap meets stale pools. |

The simulated start is the next occurrence of that New York weekday and time after the chain's current time, so runs happen on future block timestamps on anvil. That is expected.

## Output

`out/summary.json` (per ticker, for `hook` and `control` pools, plus `hookMinusControl` and totals):

- `volume`, `arbVolume`, `retailVolume` (USD), `fees` (USD of fees charged)
- `arbProfit` (gross) and `arbProfitNetOfGas`
- `retailFeePaid`, `retailAvgFeeBps`
- `lpPnl`: LP profit versus holding the starting inventory, valued at the hidden true price at the end, **fees included**; `lpPnlExFees` removes the fees
- `swapsSurchargedPct`, `retailSurchargedPct`, `arbSurchargedPct`: share of swaps where the fee charged was above the base fee
- `failedSwaps`

`out/metrics.jsonl` has one line per tick: time, session phase, true prices, and per pool price, deviation in bps, cumulative LP P&L, fees and volume.

## How to read the results honestly

- Each pool has **one pool-wide P&L**. The deployment seeds three LPs (wide, medium, tight range) into every pool, but swap-flow accounting cannot split a pool's P&L between them, so no per-LP split is reported.
- `lpPnl` is a mark-to-market number over a short window. It includes random price drift on whatever inventory the pool ended up holding, so single runs are noisy. Compare `hook` against `control`: they see the same prices and the same retail orders, so the difference is the effect of the hook.
- The arbitrageur is one rational bot with a fixed gas model ($0.50 per swap). Real arbitrageurs differ, so the surcharge gain is a property of this bot, not a forecast.
- Pools hold constant liquidity per tick for sizing purposes; swaps are capped at a 1% price move so they stay inside the LP ranges. Overshoots at range edges can happen and the bot trades back.
- The model venue and the anvil venue should agree in direction, not to the cent: the contract uses integer math and real tick-based liquidity.
- Starting prices come from `deployments/seed.json` (last 1h close at deploy time); META, GOOGL and AAPL volatilities are rough estimates.
