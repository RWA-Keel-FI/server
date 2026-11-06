# DeviationFee CRE workflow

Chainlink CRE workflow (TypeScript) that writes a live US-stock reference price and a session-open flag to
`RefPriceOracle` on Unichain Sepolia every minute. Design, verified/unverified facts and run book: [ARCHITECTURE.md](./ARCHITECTURE.md).

```
cre/
  project.yaml  secrets.yaml  .env.example
  deviation-workflow/
    main.ts                 CRE entry (cron -> session -> node-mode price -> signed report -> writeReport)
    workflow.yaml           targets: staging-settings, demo-settings
    config.staging.json     live config (set "receiver" after deploying the oracle)
    config.demo.json        fixture replay (forceSessionOpen + local quoteUrlTemplate)
    src/session.ts          pure NY session calendar (DST, NYSE holidays, early closes)
    src/report.ts           pure abi.encode(bytes32,uint64,bool,uint64) + feedId + price scaling
    src/quote.ts            pure quote parsers (Yahoo, Finnhub) and freshness guard
    src/config.ts           config type + validation
    test/*.test.ts          26 tests (node:test; no network, no SDK needed)
    fixtures/*.json         recorded quotes for the demo
```

## Quick start

```bash
cd deviation-workflow
node --test test/*.test.ts      # unit tests, plain Node >= 22.18 (type stripping), no install needed
bun install                     # installs @chainlink/cre-sdk (resolved 1.23.0) and runs `bunx cre-setup`
bun run typecheck && bun run compile    # strict typecheck + WASM build
```

Simulate (needs the `cre` CLI and `cre login`; see ARCHITECTURE.md section 8):

```bash
cd .. && cp .env.example .env     # fill CRE_ETH_PRIVATE_KEY, never commit
cre workflow simulate deviation-workflow --target staging-settings --non-interactive --trigger-index 0              # dry run
cre workflow simulate deviation-workflow --target staging-settings --non-interactive --trigger-index 0 --broadcast  # real tx
```

Deploy the oracle with the **MockKeystoneForwarder** `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` for simulation
(production testnet KeystoneForwarder: `0x98B8335d29Aca40840Ed8426dA1A0aAa8677d8D1`). Chain name in yaml/config:
`ethereum-testnet-sepolia-unichain-1`.

Status: unit tests pass, `main.ts` type-checks and compiles to WASM against SDK 1.23.0. `cre workflow simulate` has **not** been run
(CLI/account not available in the build environment).
