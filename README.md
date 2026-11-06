# Keel server

Everything off-chain for **Keel**, a Uniswap v4 hook that sets a swap fee from how far a tokenized-stock pool has drifted from the stock's real price. Part of three repos meant to be checked out side by side:
[`contracts`](https://github.com/RWA-Keel-FI/contracts) (the hook, oracle and tokens, with the deployed Arc Testnet addresses), [`server`](https://github.com/RWA-Keel-FI/server) (this one), [`client`](https://github.com/RWA-Keel-FI/client) (React dapp).

> **Test tokens only.** The stock token is a mock, nothing here is a real security or has value.

## What is in here

| Folder | What it does |
|---|---|
| `cre/` | **Chainlink CRE workflow** (TypeScript). Fetches the TSLA price and writes it to the on-chain oracle. |
| `backtest/` | **Python replay** of real tokenized-stock swaps on Ethereum against the fee rule. |
| `sim/` | **TypeScript market simulation** on a local anvil chain: arbitrage bot, retail bot, price feeder, three scenarios. |
| `scripts/` | Deploy and demo scripts for local anvil and for Arc Testnet. |

## The idea in one paragraph

A tokenized stock trades on a Uniswap pool all day, but the real stock only trades in market hours. When the real price moves, arbitrageurs trade the pool back and the LPs pay for it. Keel's hook compares the pool price with a reference price on-chain and raises the fee only for swaps that move the pool *toward* the reference (the arbitrage direction), by half the noise-adjusted gap, capped at 2%. Everyone else pays the base fee. If the reference is missing or stale, everyone pays the base fee. The contracts and the formula are in the `contracts` repo.

## `cre/`: the price feed

A Chainlink CRE workflow, target chain `arc-testnet`, feed `TSLA`:

```
cron (every minute) -> US session check (DON time) ->
  session open: each node fetches the quote over HTTP (Yahoo), median consensus ->
  signed report abi.encode(bytes32 feedId, uint64 priceE8, bool sessionOpen, uint64 asOf) ->
  EVMClient.writeReport -> Chainlink KeystoneForwarder -> RefPriceOracle.onReport
```

What is verified and what is not:

- **Verified:** strict typecheck, 25 unit tests, compiles to WASM with `@chainlink/cre-sdk` 1.23.0, and the quote and report-encoding code was run against live Yahoo TSLA data (plain `fetch`, outside the CRE runtime).
- **Not run:** `cre workflow simulate` and a deploy to the Chainlink network. Both need `cre login` and a CRE account with deploy access, which has not been set up. Network behavior (Yahoo from node IPs, `writeReport` to Arc, multi-node consensus) is therefore untested.
- Prices come from a real HTTP provider only (Yahoo, with an optional Finnhub fallback). Yahoo is unofficial and a single point of failure.
- Outside US trading hours (04:00 to 20:00 New York time on trading days) the workflow writes nothing, so the on-chain price goes stale and the hook fails open to the base fee. The oracle ignores zero-price reports, so a "market closed" heartbeat is not possible.
- `receiver` in the configs is the deployed oracle. `bun run set-receiver` fills it from the deployment manifest.

Steps to run it (login, secrets, simulate, deploy) are in [`cre/README.md`](cre/README.md). The design notes are in `cre/ARCHITECTURE.md`.

## `backtest/`: how the rule would have done on real swaps

Python (`fetch_swaps.py`, `fetch_prices.py`, `analyze.py`, `make_report.py`). It replays 60 days of real swaps in Ondo tokenized-stock pools on Ethereum (NVDAon, TSLAon, SPYon) against the rule, with 5-minute Yahoo bars as the reference. Observed swaps are held fixed and only the fee changes.

Headline on the three core pools (NVDAon v3, NVDAon v4, TSLAon v3): 22,858 swaps, $8.7M volume.

| | |
|---|---|
| Swaps that pay a surcharge | 1.6% (always in the arbitrage direction) |
| Volume surcharged | 5.45% |
| Sub-$1k swaps surcharged | 275 of 21,074 (1.3%) |
| Swaps surcharged against the direction | 0 (by construction) |
| LP P&L change | **$2,069 on $8.7M of volume (+5.5%)** |

The honest reading, from the report: this is a protective rule, not a profit engine. The gain is concentrated (10 swaps carry 70% of the extra fee), it is a static replay (real arbitrageurs react), and it disappears if about half of the surcharged volume leaves. SPYon is excluded from the headline because its price sits about 91 bps above SPY for an unexplained reason. Full tables, robustness cases and caveats: [`backtest/RESULTS.md`](backtest/RESULTS.md). Reproduce:

```bash
cd backtest
python3 -I fetch_swaps.py && python3 -I fetch_prices.py && python3 -I analyze.py && python3 -I make_report.py
```

## `sim/`: a simulated market on local anvil

One process, one simulated clock, four parts: a price feeder that plays the CRE workflow, an arbitrageur, a retail bot (the same order goes to the hook pool and the control pool so the fee difference is a paired comparison), and an LP-P&L recorder. It refuses any chain id other than 31337 and any non-localhost RPC. Scenarios: `calm`, `volatile`, `weekend-gap`.

```bash
cd sim && pnpm install
./fresh-chain.sh                       # local anvil with the demo deployed
pnpm sim up --scenario calm --venue anvil --ticks 120
pnpm test && pnpm typecheck
```

Details are in [`sim/README.md`](sim/README.md).

## `scripts/`: deploying

Scripts expect the three repos side by side with a `deployments/` folder next to them (the scripts create it):

```
parent/
  contracts/   server/   client/   deployments/
```

| Script | Purpose |
|---|---|
| `deploy-local.sh` | Deploy the whole demo to a local anvil: its own v4 PoolManager, plus a mock forwarder and mock USDC. |
| `deploy-arc.sh fork` | Rehearse the full Arc flow on a local fork of Arc Testnet. Sends nothing to the real chain. |
| `deploy-arc.sh real` | **Real broadcast** to Arc Testnet (chain 5042002). Needs `contracts/.env` with `DEPLOYER_PRIVATE_KEY`. |
| `arc_stages.py` | The seed, demo and handover steps, sent with `cast send` (see below). |
| `build_manifest.py` | Turns the deploy log into `deployments/<name>.json` and copies the ABIs. |
| `push-price.sh`, `smoke-local.sh` | Local helpers. |

`deploy-arc.sh real` does four things in order: deploy the contracts, write one real TSLA quote to the oracle (the deployer is its temporary forwarder), mint `tTSLA` and add liquidity to both pools, run the demo swaps, then hand the oracle to Chainlink's production forwarder.

Notes:

- The steps that move USDC use `cast send` instead of `forge script`, because Arc's USDC uses chain precompiles that Foundry's local EVM does not have. The deployer key is passed to `cast send --private-key`, so it is visible in the local process list during each call. Use a throwaway testnet key. The script does not print it.
- The fork rehearsal replaces Arc's USDC with a plain 6-decimal ERC-20, so it covers our contracts but not Arc's own USDC behavior.
- `.env` files are gitignored. Only `*.env.example` files are committed.

The Arc Testnet addresses are in the [`contracts` README](https://github.com/RWA-Keel-FI/contracts#deployment-arc-testnet-chain-id-5042002).
