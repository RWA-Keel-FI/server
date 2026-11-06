# CRE agent: reference-price workflow

Scope: the Chainlink CRE side of DeviationFee. It feeds `RefPriceOracle` with a live US-stock price and a
"session open" flag. Nothing here deploys, signs, or sends transactions.

## 1. Shared interface (fixed by the plan)

```
report = abi.encode(bytes32 feedId, uint64 priceE8, bool sessionOpen, uint64 asOf)   // 4 x 32 = 128 bytes
CRE workflow --signed report--> KeystoneForwarder --onReport(metadata, report)--> RefPriceOracle (ReceiverTemplate)
```

| Field | Meaning |
|---|---|
| `feedId` | `bytes32("NVDA")`: ASCII ticker, left-aligned, zero right-padded (`tickerToFeedId`). **Assumption for the contracts agent**; the shared spec only says `bytes32`. |
| `priceE8` | USD price x 1e8 (188.26 -> `18826000000`). `0` when `sessionOpen == false`. |
| `sessionOpen` | true iff a live reference price is expected (US session per `sessionMode`) and a fresh quote reached consensus. |
| `asOf` | DON time (unix seconds) when the report was produced. |

Contract-side expectations (the hook/oracle agents should match; this is what the quant rule needs):
- `sessionOpen == false` or `now - asOf > staleAfter` => hook charges the base fee `f0` (**fail-open**, never a max fee).
- The oracle must accept `priceE8 == 0` when `sessionOpen == false` (heartbeat) and must not read the price in that case.
- `ReceiverTemplate` metadata is 64 bytes in production (62 + 2-byte reportId). Do not require exactly 62.

## 2. Workflow steps (`deviation-workflow/main.ts`)

```
cron "0 * * * * *" (every minute)
 1. nowSec = runtime.now()                    # DON time, not Date.now()
 2. session = getSessionState(nowSec, mode)   # pure; America/New_York, holidays, early closes
 3. for each feed (NVDA, TSLA):
      session closed -> every closedHeartbeatMinutes write {price 0, sessionOpen false, asOf now}; else skip
      session open   -> runtime.runInNodeMode(fetch, consensusMedianAggregation<bigint>())().result()
                          fetch (each node): HTTP GET quote -> parse -> reject if stale/zero -> priceE8
                        write {priceE8, true, nowSec}
 4. write = runtime.report({encodedPayload, encoderName:"evm", signingAlgo:"ecdsa", hashingAlgo:"keccak256"})
            -> EVMClient.writeReport({receiver, report, gasConfig:{gasLimit}})
            -> check txStatus == SUCCESS and receiverContractExecutionStatus != REVERTED
```

Failure handling per feed (one feed failing never blocks the other):
- A node whose HTTP call, parse or freshness check throws is dropped from consensus (docs: throwing is the intended signal).
- If consensus fails entirely: `onFetchFailure = "skip"` (default; oracle goes stale and the hook fails open) or `"write_closed"` (explicit `sessionOpen=false` report, faster fail-open, costs a tx).
- The run throws only if the session is open and **every** feed failed, so the failure is visible in simulation/ops.

## 3. Price source options

| Option | Pros | Cons / failure behavior | Verdict |
|---|---|---|---|
| **Yahoo `v8/finance/chart`** (unofficial, no key) | Free, no secrets, same data family as the backtest (1m bars incl. pre/post). Verified live today: returns JSON with `timestamp[]` and `indicators.quote[0].close[]`. | Unofficial/ToS-grey. **HTTP 429 without a browser-like `User-Agent`** (checked with curl: 429 vs 200); we send `Mozilla/5.0`. Untested: whether many DON node IPs get throttled. Pre/post bars can be sparse, hence the freshness check. Failure => node throws => dropped. | **Hackathon primary** (simulation runs from one machine). |
| **Finnhub `/quote`** (keyed) | Stable JSON (`c` price, `t` unix time), free key, supports `runtime.getSecret`. | Needs `secrets.yaml` + `.env`. Free-tier rate limit and real-time coverage **not verified** (docs fetch returned only the page title). Every node sees the key. | **Fallback provider** (`"provider": "finnhub"`). |
| **Chainlink Data Streams 24/5 US equities** | First-party, covers pre/post/overnight, market-status codes. | Launched 20 Jan 2026 per Chainlink. Requires Data Streams credentials; I did **not** find NVDA/TSLA stream IDs or any CRE integration guide. Streams switch per session, so a continuous feed needs session-switching logic. | **Production target**, not for this weekend. |

**Cached fallback for the demo** (CRE workflows are stateless, so "cache" = a recorded quote served locally):
`config.demo.json` + `fixtures/*.json` + `demo-settings` target set `quoteUrlTemplate` to a local server and
`forceSessionOpen: true`, with `maxQuoteAgeSec` huge. Run `python3 -m http.server 8787 --directory deviation-workflow/fixtures`.
The same Yahoo parser reads the fixture, so the demo exercises the real code path. **Demo-only**: `forceSessionOpen`
bypasses the calendar; never use it for a real run. Whether simulation can reach `127.0.0.1` is unverified.

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

- Open session: one report per feed per cron tick. Node-side guard rejects quotes older than `maxQuoteAgeSec` (120 s) or >60 s in the future.
- Closed session: heartbeat every `closedHeartbeatMinutes` (30) so the oracle can tell "closed on purpose" from "workflow dead".
- Cron: 6 fields, **seconds first** (`sec min hour dom month dow`); minimum interval **30 s** (docs). Default is every minute.
  Why not 5 min: NVDA 5-min-bar vol is 0.85 bps/sqrt(s), so a quote `age` seconds old is noisy by `0.85*sqrt(age)` bps
  (about 4.7 bps at a 30 s average age, 14.7 bps at 300 s). The hook's noise term `sigma*sqrt(age)` uses the same number.
- Not implemented: skip-write-if-unchanged (needs an on-chain read; `callContract` shape not verified).

## 6. Consensus

- `consensusMedianAggregation<bigint>()` over `priceE8` (docs: median supports `number`, `bigint`, `Date`).
- In simulation one node handles consensus; deployed, multi-node BFT consensus runs (docs).
- The median is taken over prices only; session flag and `asOf` come from DON time, which is already consensus-derived.
- Open risk: all nodes read the same single provider, so consensus protects against node faults, not provider errors or manipulation.

## 7. Verified vs unverified

Verified from docs.chain.link/cre pages I could fetch (and, where marked, by type-checking/compiling against the real SDK):
- Cron trigger: 5 or 6 fields, seconds first, min 30 s, `payload.scheduledExecutionTime` (bigint seconds + nanos).
- HTTP in node mode: `new HTTPClient().sendRequest(nodeRuntime, req).result()`, body is bytes -> `TextDecoder`; `runtime.runInNodeMode(fn, consensusMedianAggregation())().result()`.
- Report + write: `encodeAbiParameters`, `runtime.report({encodedPayload: hexToBase64(...), encoderName:"evm", signingAlgo:"ecdsa", hashingAlgo:"keccak256"})`, `evm.writeReport(runtime,{receiver,report,gasConfig:{gasLimit:"..."}})`, `TxStatus.SUCCESS`, `receiverContractExecutionStatus`.
- `getNetwork({chainFamily:"evm", chainSelectorName})`, `new EVMClient(network.chainSelector.selector)`.
- Chain name **`ethereum-testnet-sepolia-unichain-1`**; Unichain Sepolia needs CLI >= 1.5.0, TS SDK >= 1.3.0.
- Forwarders (Forwarder Directory): **MockKeystoneForwarder (simulation) `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1`**, **KeystoneForwarder (production testnet) `0x98B8335d29Aca40840Ed8426dA1A0aAa8677d8D1`**.
- Simulation: `cre workflow simulate <workflow-dir> --target <target>`; `--non-interactive --trigger-index 0`; default is a dry run (empty tx hash `0x`), `--broadcast` sends real txs; wallet = `CRE_ETH_PRIVATE_KEY` in `.env`, funded on the target chain (docs say the simulator needs it set even without chain interaction).
- Consumer: implement `IReceiver`; `ReceiverTemplate(forwarder)` + `_processReport(bytes calldata report)`. For simulation deploy with the **Mock** forwarder and do **not** call `setExpectedWorkflowId/Author/Name` (they break simulation); for production switch to the real forwarder (`setForwarderAddress`) and then add the checks.
- Project layout: `project.yaml` (targets, rpcs), `secrets.yaml` (`secretsNames`), `.env`, per-workflow `workflow.yaml` (`workflow-name`, `workflow-artifacts.{workflow-path,config-path,secrets-path}`), `config.<target>.json`. Targets must exist in both yaml files.
- Time: use `runtime.now()` (DON time), not `Date.now()`.
- By real execution here: `@chainlink/cre-sdk` **1.23.0** resolves from `^1.3.0`; `main.ts` type-checks (strict) against it and `cre-compile main.ts out.wasm` produced a 2.5 MB WASM (scratch copy, javy v8.1.0 downloaded by the SDK). This confirms every import name used (`CronCapability`, `EVMClient`, `HTTPClient`, `Runner`, `TxStatus`, `bytesToHex`, `consensusMedianAggregation`, `getNetwork`, `handler`, `hexToBase64`, `EVM_PB` from `@chainlink/cre-sdk/pb`, `runtime.getSecret({id}).result().value`, plain-object `headers`, `nodeRuntime.now()`).

Unverified (not run, or docs not readable):
- **`cre workflow simulate` was not run**: the `cre` CLI is not installed here and needs a Chainlink account (`cre login`). No end-to-end run, no broadcast.
- Runtime behavior of the Yahoo call from CRE nodes (429/throttling from node IPs, header passthrough).
- Whether simulation can reach `http://127.0.0.1:8787` for the demo fixtures.
- Finnhub response field names (`c`, `t`) are from memory; docs page returned no content. Free-tier limits unknown.
- Data Streams stream IDs / CRE integration for equities; early-close post-hours; `config.<target>.json` naming is the `cre init` convention (staging/production) and `demo-settings` is a custom target name (docs: targets can be renamed freely).
- Docs show two median styles (`consensusMedianAggregation()` vs `median` inside `ConsensusAggregationByFields`); I used the former.
- Mock forwarder metadata limitation (no workflow name/owner) is from the docs; production behavior untested.

## 8. Run book

```bash
cd server/cre/deviation-workflow && bun install         # postinstall runs `bunx cre-setup`
cp ../.env.example ../.env                        # set CRE_ETH_PRIVATE_KEY (64 hex, no 0x); fund it on Unichain Sepolia for --broadcast
# edit config.staging.json: "receiver" = deployed RefPriceOracle (constructed with the MOCK forwarder above)
cd .. && cre login
cre workflow simulate deviation-workflow --target staging-settings --non-interactive --trigger-index 0              # dry run
cre workflow simulate deviation-workflow --target staging-settings --non-interactive --trigger-index 0 --broadcast  # real tx -> README txhash
# demo without live data:
python3 -m http.server 8787 --directory deviation-workflow/fixtures &
cre workflow simulate deviation-workflow --target demo-settings --non-interactive --trigger-index 0 --broadcast
# local checks (no account needed):
cd deviation-workflow && bun run test && bun run typecheck && bun run compile
```

Handoffs: contracts agent needs the `feedId` convention, the `priceE8 == 0 / sessionOpen == false` heartbeat rule, the mock forwarder address for the simulation deploy, and `staleAfter` > 2x cron interval (suggest 180 s). Submission needs the broadcast tx hash and the simulation log in the README.
