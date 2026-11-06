# CRE agent: reference-price workflow

Scope: the Chainlink CRE side of DeviationFee, targeting **Arc Testnet** (CRE chain name `arc-testnet`, chainId 5042002).
It feeds `RefPriceOracle` with a live TSLA price and a "session open" flag. Nothing here deploys, signs, or sends transactions.

## 1. Shared interface (fixed by the plan)

```
report = abi.encode(bytes32 feedId, uint64 priceE8, bool sessionOpen, uint64 asOf)   // 4 x 32 = 128 bytes
CRE workflow --signed report--> KeystoneForwarder --onReport(metadata, report)--> RefPriceOracle (ReceiverTemplate)
```

| Field | Meaning |
|---|---|
| `feedId` | `bytes32("TSLA")`: ASCII ticker, left-aligned, zero right-padded (`tickerToFeedId`). |
| `priceE8` | USD price x 1e8 (358.21 -> `35821000000`). `0` when `sessionOpen == false`. |
| `sessionOpen` | true iff a live reference price is expected (US session per `sessionMode`) and a fresh quote reached consensus. |
| `asOf` | DON time (unix seconds) when the report was produced. |

Contract-side expectations (the hook/oracle agents should match; this is what the quant rule needs):
- `sessionOpen == false` or `now - asOf > staleAfter` => hook charges the base fee `f0` (**fail-open**, never a max fee).
- **Important (read from `contracts/src/RefPriceOracle.sol`):** the oracle IGNORES (emits `ReportIgnored`, no revert) any report with
  `priceE8 == 0`, an `asOf` more than 60 s in the future, or `asOf <= stored asOf`. So a "closed" heartbeat can never be recorded;
  the closed state is represented purely by staleness. The workflow therefore sends no closed heartbeats by default
  (`closedHeartbeatMinutes: 0`) and `onFetchFailure: "write_closed"` is effectively a no-op on-chain.
- `ReceiverTemplate` metadata is 64 bytes in production (62 + 2-byte reportId). Do not require exactly 62.

## 2. Workflow steps (`deviation-workflow/main.ts`)

```
cron "0 * * * * *" (every minute)
 1. nowSec = runtime.now()                    # DON time, not Date.now()
 2. session = getSessionState(nowSec, mode)   # pure; America/New_York, holidays, early closes
 3. for each feed (TSLA):
      session closed -> every closedHeartbeatMinutes write {price 0, sessionOpen false, asOf now}; else skip
      session open   -> runtime.runInNodeMode(fetch, consensusMedianAggregation<bigint>())().result()
                          fetch (each node): for each provider/URL in order: HTTP GET quote -> parse -> reject if stale/zero -> priceE8
                        write {priceE8, true, nowSec}
 4. write = runtime.report({encodedPayload, encoderName:"evm", signingAlgo:"ecdsa", hashingAlgo:"keccak256"})
            -> EVMClient.writeReport({receiver, report, gasConfig:{gasLimit}})
            -> check txStatus == SUCCESS and receiverContractExecutionStatus != REVERTED
```

Failure handling per feed (one feed failing never blocks the other):
- A node tries each provider/URL in order (`yahoo`: query1 then query2 host; optional `finnhub`); only if all fail does it throw and get dropped from consensus.
- If consensus fails entirely: `onFetchFailure = "skip"` (default; oracle goes stale and the hook fails open) or `"write_closed"` (explicit `sessionOpen=false` report, faster fail-open, costs a tx).
- The run throws only if the session is open and **every** feed failed, so the failure is visible in simulation/ops.

## 3. Price source options

| Option | Pros | Cons / failure behavior | Verdict |
|---|---|---|---|
| **Yahoo `v8/finance/chart`** (unofficial, no key) | Free, no secrets, same data family as the backtest (1m bars incl. pre/post). Verified live today: returns JSON with `timestamp[]` and `indicators.quote[0].close[]`. | Unofficial/ToS-grey. **HTTP 429 without a browser-like `User-Agent`** (checked with curl: 429 vs 200); we send `Mozilla/5.0`. Untested: whether many DON node IPs get throttled. Pre/post bars can be sparse, hence the freshness check. Failure => node throws => dropped. | **Hackathon primary** (simulation runs from one machine). |
| **Finnhub `/quote`** (keyed) | Stable JSON (`c` price, `t` unix time), free key, supports `runtime.getSecret`. | Needs `secrets.yaml` + `.env`. Free-tier rate limit and real-time coverage **not verified** (docs fetch returned only the page title). Every node sees the key. | **Fallback provider** (`"provider": "finnhub"`). |
| **Chainlink Data Streams 24/5 US equities** | First-party, covers pre/post/overnight, market-status codes. | Launched 20 Jan 2026 per Chainlink. Requires Data Streams credentials; I did **not** find TSLA stream IDs or any CRE integration guide. Streams switch per session, so a continuous feed needs session-switching logic. | **Production target**, not for this weekend. |

**No fixtures, no fake prices.** The localhost fixture replay, `quoteUrlTemplate` and `forceSessionOpen` were removed. The only price
sources are the real HTTP providers in `providers` (default `["yahoo"]`; add `"finnhub"` plus the `FINNHUB_API_KEY` secret for a keyed
second source). Outside the US session (or on weekends/holidays) the workflow writes nothing, so to see a price in `cre workflow simulate`
run it during 04:00-20:00 ET on an NYSE trading day. Yahoo chart verified live (HTTP 200, fresh 1m bar, both query1 and query2 hosts).

## 4. US session calendar (`src/session.ts`, pure)

- No `Intl`/timezone APIs: CRE compiles TypeScript to WASM (QuickJS, per migration docs), so NY time is computed
  with integer math. DST: 2nd Sunday of March 02:00 EST (07:00 UTC) to 1st Sunday of November 02:00 EDT (06:00 UTC).
- Holidays computed by rule and **tested against the nyse.com lists for 2026 and 2027**: New Year's (Saturday not
  observed on Friday), MLK, Washington's Birthday, Good Friday (Easter algorithm), Memorial Day, Juneteenth,
  Independence Day, Labor Day, Thanksgiving, Christmas, with Sat->Fri / Sun->Mon observance.
- Early closes (13:00 ET): day after Thanksgiving, Dec 24 and Jul 3 when Mon-Thu. Matches nyse.com (2026: Nov 27, Dec 24; 2027: Nov 26).
- Windows (NYSE Arca hours from nyse.com): pre 04:00-09:30, core 09:30-16:00, late 16:00-20:00.
  - `sessionMode: "regular"` => open only in core. `"extended"` (default, matches the backtest bars) => 04:00-20:00.
  - **Early-close days: everything after 13:00 is treated as closed** (conservative; post-close hours on those days unverified).
  - **Overnight (20:00-04:00, Sunday 20:00 onward) is not covered**: Yahoo has no data there. That needs the Chainlink 24/5 streams.
- Anything uncertain returns `open=false` (fail-open for users).

## 5. Staleness, heartbeat, cadence

- Open session: one report per feed per cron tick. Each report costs USDC gas on Arc (USDC is Arc's native gas token). Node-side guard rejects quotes older than `maxQuoteAgeSec` (120 s) or >60 s in the future.
- Closed session: no writes by default (`closedHeartbeatMinutes: 0`) because the oracle ignores zero-price reports. A positive value re-enables sessionOpen=false heartbeats.
- Cron: 6 fields, **seconds first** (`sec min hour dom month dow`); minimum interval **30 s** (docs). Default is every minute.
  Why not 5 min: NVDA 5-min-bar vol (backtest figure; TSLA not measured here) is 0.85 bps/sqrt(s), so a quote `age` seconds old is noisy by `0.85*sqrt(age)` bps
  (about 4.7 bps at a 30 s average age, 14.7 bps at 300 s). The hook's noise term `sigma*sqrt(age)` uses the same number.
- Not implemented: skip-write-if-unchanged (needs an on-chain read; `callContract` shape not verified).

## 6. Consensus

- `consensusMedianAggregation<bigint>()` over `priceE8` (docs: median supports `number`, `bigint`, `Date`).
- In simulation one node handles consensus; deployed, multi-node BFT consensus runs (docs).
- The median is taken over prices only; session flag and `asOf` come from DON time, which is already consensus-derived.
- Open risk: all nodes read the same single provider, so consensus protects against node faults, not provider errors or manipulation.

## 7. Verified vs unverified

Verified against live docs (docs.chain.link, fetched 2026-11-06) :
- **Arc Testnet**: chain name `arc-testnet`; minimum CLI v1.0.7, TS SDK v1.3.1 (supported-networks page). Installed here: CLI v1.39.0, SDK 1.23.0 (also latest on npm).
- Forwarders on `arc-testnet` (Forwarder Directory): **MockKeystoneForwarder (simulation) `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1`**, **KeystoneForwarder (production) `0x76c9cf548b4179F8901cda1f8623568b58215E62`**.
- Arc public RPC `https://rpc.testnet.arc.network` answers `eth_chainId = 0x4cef52 = 5042002`; USDC is the native gas token (docs.arc.network).
- Config layout: `project.yaml` rpcs per target (supports `${VAR}`), `workflow.yaml` (`workflow-name`, optional `deployment-registry`, `workflow-artifacts`), `secrets.yaml` (`secretsNames` -> env var), targets must exist in both.
- Deploy: requires approved access (`cre account access`); private registry (`deployment-registry: "private"`) needs only `cre login`, onchain registry needs a linked key and Ethereum Mainnet gas.

Verified by type-check/compile against the installed SDK 1.23.0 (previous `UNVERIFIED:` tags, all resolved):
- `import { EVM_PB } from "@chainlink/cre-sdk/pb"` is a real export (`dist/pb.d.ts`: `export * as EVM_PB`), and `EVM_PB.ReceiverContractExecutionStatus.REVERTED` exists.
- `runtime.getSecret({ id }).result()` returns an SDK `Secret` with `value: string` (`sdk_pb.d.ts`; `runtime-impl.js` getSecret). Plain `{id}` request objects are accepted.
- `headers` as a plain object on `HTTPClient.sendRequest`, `nodeRuntime.now()`, `runtime.runInNodeMode(fn, consensusMedianAggregation<bigint>())`, `runtime.report`, `EVMClient.writeReport` + `TxStatus`, `WriteReportReply.txHash/errorMessage/receiverContractExecutionStatus`.
- `main.ts` type-checks under `tsc --strict` and `cre-compile` builds a 2.5 MB WASM; 25 unit tests pass (`bun run test`); `scripts/set-receiver.ts` type-checks and was exercised for the refuse/accept paths.
- Live data path (outside the CRE runtime, same parser code): Yahoo TSLA chart returned HTTP 200 from query1 and query2, parsed to a fresh price, and `encodeReport` produced a 128-byte payload.

Unverified (not run):
- **`cre workflow simulate` has NOT been run**: the CLI is installed (v1.39.0) but every command needs `cre login` (or `CRE_API_KEY`) and no CRE account is available here. No dry run, no broadcast, so end-to-end behavior (HTTP header passthrough from the simulator, Yahoo behavior from DON node IPs, `writeReport` against `arc-testnet`, consensus) is untested.
- Whether the oracle (still to be deployed by the contracts agent) accepts reports from the forwarder in practice; the report layout matches `RefPriceOracle._processReport` by reading the code only.
- Finnhub response field names (`c`, `t`) are from memory; Finnhub is optional and disabled by default.
- Data Streams stream IDs / CRE integration for equities; early-close post-hours.
- Deploy was not attempted (needs deploy access); `deployment-registry` choice left to the user.
- Docs show two median styles (`consensusMedianAggregation()` vs `median` inside `ConsensusAggregationByFields`); the former type-checks and compiles.
- The oracle only trusts one forwarder at a time: simulate needs the mock forwarder, a deployed workflow needs the production one (switch with `setForwarderAddress`).

## 8. Run book

See [README.md](./README.md) for the exact steps (`cre login`, `set-receiver`, `simulate`, `deploy`, secrets).
