# DeviationFee CRE workflow (Arc Testnet)

Chainlink CRE workflow (TypeScript) that writes a live **TSLA** reference price and a session-open flag to `RefPriceOracle`
on **Arc Testnet** (CRE chain name `arc-testnet`, chainId 5042002) every minute. Design and verified/unverified list:
[ARCHITECTURE.md](./ARCHITECTURE.md).

```
cre/
  project.yaml  secrets.yaml  .env.example
  deviation-workflow/
    main.ts                 cron -> session -> node-mode HTTP price (median consensus) -> signed report -> writeReport
    workflow.yaml           targets: staging-settings (simulate), production-settings (deploy), fork-settings (local anvil fork)
    config.{staging,production,fork}.json   receiver = 0x0 until `set-receiver` runs
    scripts/set-receiver.ts reads deployments/<network>.json, writes the oracle address into the configs
    src/  session.ts report.ts quote.ts config.ts     pure logic
    test/ 25 unit tests (node:test, no network)
```

Price source: real HTTP only (Yahoo v8 chart, query1 then query2 host; optional Finnhub). No fixtures or forced-open switches.
The workflow writes nothing outside 04:00-20:00 ET on NYSE trading days (extended mode), so a simulation on a weekend
returns `wrote 0, failed 0`. Run it during the US session to see a price.

Chain facts (checked against docs.chain.link/cre, Nov 2026): chain name `arc-testnet`, needs CLI >= 1.0.7 and TS SDK >= 1.3.1
(this repo: CLI v1.39.0, SDK 1.23.0). Forwarders on arc-testnet:

| Use | Address |
|---|---|
| `cre workflow simulate --broadcast` (MockKeystoneForwarder) | `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` |
| deployed workflow (KeystoneForwarder) | `0x76c9cf548b4179F8901cda1f8623568b58215E62` |

The oracle trusts one forwarder at a time (`ReceiverTemplate.setForwarderAddress`, owner only). Deploy it with the mock forwarder
to simulate; before `cre workflow deploy`, call `setForwarderAddress(0x76c9...E62)`.

## Prerequisites and known failures

- **Bun >= 1.2.21 is required** (the CRE SDK declares it). With an older Bun (1.2.16 was seen) the workflow compiles but `cre workflow simulate`
  fails at start-up with `Failed to create engine: failed to execute subscribe ... wasm trap: wasm unreachable instruction executed`, even for
  a one-line workflow. Check with `bun --version`, fix with `bun upgrade`.
- **`environment variable FINNHUB_API_KEY_ENV for secret value not found`**: the CLI requires every env var named in `secrets.yaml` to exist.
  The default setup (Yahoo) needs no secrets, so `secrets-path` is commented out in `deviation-workflow/workflow.yaml`. Only enable it
  (and export `FINNHUB_API_KEY_ENV`) if you add `finnhub` to `providers`.
- `CRE_ETH_PRIVATE_KEY` goes in `server/cre/.env` (not in `client/.env`). It must be 64 hex characters, without `0x`. A dry run works
  without it (the CLI uses a default key and says so); `--broadcast` needs a key holding Arc Testnet USDC for gas.

## 0. Local checks (no account needed)

```bash
cd server/cre/deviation-workflow
bun install            # @chainlink/cre-sdk 1.23.0, runs `bunx cre-setup`
bun run test           # 25 unit tests
bun run typecheck      # strict tsc, workflow + tests + scripts
bun run compile        # cre-compile -> out.wasm (git-ignored)
```

## 1. Install the CRE CLI (once)

Official installer (`curl -sSL https://app.chain.link/cre/install.sh | bash`; reads the GitHub release, verifies a GPG signature).
It appends to your shell rc; to avoid that, download the script, read it, and run `SHELL=/bin/sh bash install.sh`, then add
`export PATH="$HOME/.cre/bin:$PATH"`. Check: `cre version` (>= 1.0.7 for Arc; tested with v1.39.0).

## 2. Log in (needs your Chainlink account)

```bash
cre login            # opens a browser; creates a CRE account if you have none (https://docs.chain.link/cre)
cre whoami           # must show your email/org
```
Non-interactive alternative: set `CRE_API_KEY` in the environment. Every `cre workflow ...` command fails with
"not logged in" until this is done. Simulation needs login but not deploy approval.

## 3. Secrets and env (never commit)

```bash
cd server/cre && cp .env.example .env
# .env: CRE_ETH_PRIVATE_KEY=<64 hex, no 0x>  (required by the CLI even for dry runs)
#       fund that address with Arc Testnet USDC (Arc's native gas token) only if you use --broadcast: https://faucet.circle.com
# FINNHUB_API_KEY_ENV only if you add "finnhub" to "providers" in the config. Default setup needs no API key.
```
`secrets.yaml` only maps secret ids to env var names. For a deployed workflow, secret values live in the Vault DON: `cre secrets create`
(only needed with Finnhub).

## 4. Set the receiver (deployed RefPriceOracle)

```bash
cd server/cre/deviation-workflow
bun run set-receiver                 # deployments/arc-testnet.json -> config.staging.json + config.production.json
bun run set-receiver -- --fork       # deployments/arc-fork.json    -> config.fork.json
```
It reads `oracle` (and checks `chainId == 5042002`, warns on an unknown `forwarder`) and **refuses to run if the manifest is missing**
or has no valid oracle address. The workflow itself refuses to start while `receiver` is the zero address.

## 5. Simulate

```bash
cd server/cre
cre workflow simulate deviation-workflow --target staging-settings --non-interactive --trigger-index 0              # dry run, no tx
cre workflow simulate deviation-workflow --target staging-settings --non-interactive --trigger-index 0 --broadcast  # real tx on Arc Testnet
```
Dry run exercises the real Yahoo fetch and report encoding; the write returns an empty tx hash. `--broadcast` requires the oracle to
be deployed with the **mock** forwarder and the key in `.env` to hold USDC on Arc Testnet.

Local fork dry run: `anvil --fork-url https://rpc.testnet.arc.network` (deploy the oracle there with the mock forwarder),
`bun run set-receiver -- --fork`, then `cre workflow simulate deviation-workflow --target fork-settings --non-interactive --trigger-index 0`.
(Whether the simulator accepts a local anvil fork RPC with chain name `arc-testnet` is untested; if it rejects it, try the CLI global flag
`--allow-unknown-chains` / `--allow-insecure-rpc`.)

## 6. Deploy (needs CRE deploy access)

Deploy is gated: request access with `cre account access` and wait for approval (simulation keeps working meanwhile).
```bash
cre registry list                                    # pick a registry; optionally set deployment-registry in workflow.yaml (e.g. "private")
# 1) oracle owner: RefPriceOracle.setForwarderAddress(0x76c9cf548b4179F8901cda1f8623568b58215E62)
cre workflow deploy deviation-workflow --target production-settings
cre workflow activate deviation-workflow --target production-settings    # if the CLI does not activate on deploy
```
The onchain registry also needs `cre account link-key` and Ethereum Mainnet gas; the `private` registry needs neither.
Optional hardening after deploy: `setExpectedAuthor` / `setExpectedWorkflowName` on the oracle (these break mock-forwarder simulation).
`deploy`/`activate` exist in CLI v1.39.0 (`--help` checked); they were not run (no login). Use `--unsigned` for multisig.

## Status

Verified here: unit tests, strict typecheck, WASM compile, set-receiver paths, live Yahoo TSLA fetch + parse + encode outside the CRE
runtime. **Not run: `cre workflow simulate` / `deploy`** (no CRE login in the build environment).
