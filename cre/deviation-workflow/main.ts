// DeviationFee reference-price workflow (Chainlink CRE, TypeScript SDK).
//
//   cron (every minute) -> US session check (DON time) ->
//     [session open]  node-mode HTTP price fetch per feed, median consensus ->
//     signed report abi.encode(bytes32 feedId, uint64 priceE8, bool sessionOpen, uint64 asOf) ->
//     EVMClient.writeReport -> KeystoneForwarder -> RefPriceOracle.onReport
//
// API names below are taken from docs.chain.link/cre (see ARCHITECTURE.md "Verified vs unverified").
// Lines tagged `UNVERIFIED:` use an API shape that the docs pages I could read did not fully show.

import {
  CronCapability,
  EVMClient,
  HTTPClient,
  Runner,
  TxStatus,
  bytesToHex,
  consensusMedianAggregation,
  getNetwork,
  handler,
  hexToBase64,
  type CronPayload,
  type NodeRuntime,
  type Runtime,
} from "@chainlink/cre-sdk";
// UNVERIFIED: docs say "EVM_PB from @chainlink/cre-sdk/pb"; exact export form not shown. Confirm after `bun install`.
import { EVM_PB } from "@chainlink/cre-sdk/pb";

import { validateConfig, type Config } from "./src/config.ts";
import { assertFresh, buildQuoteUrl, parseQuote } from "./src/quote.ts";
import { encodeReport, tickerToFeedId, toE8 } from "./src/report.ts";
import { getSessionState, isHeartbeatMinute } from "./src/session.ts";

// Runs on every node independently (HTTP is node-mode). Throwing drops this node from consensus
// instead of letting it contribute a bad number.
const makePriceFetcher =
  (ticker: string, apiKey: string | undefined) =>
  (nodeRuntime: NodeRuntime<Config>): bigint => {
    const cfg = nodeRuntime.config;
    const http = new HTTPClient();
    const resp = http
      .sendRequest(nodeRuntime, {
        url: buildQuoteUrl(cfg.provider, ticker, apiKey, cfg.quoteUrlTemplate),
        method: "GET" as const,
        // Yahoo returns HTTP 429 without a browser-like User-Agent (checked with curl).
        // `headers` as a plain object type-checks against @chainlink/cre-sdk 1.23.0 (runtime behavior not run).
        headers: { "User-Agent": "Mozilla/5.0" },
      })
      .result();
    if (resp.statusCode !== 200) throw new Error(`${cfg.provider} ${ticker}: HTTP ${resp.statusCode}`);
    const quote = parseQuote(cfg.provider, new TextDecoder().decode(resp.body));
    // nodeRuntime.now() = cached DON time (docs: "Time in CRE"); never use Date.now() in a workflow.
    assertFresh(quote, Math.floor(nodeRuntime.now().getTime() / 1000), cfg.maxQuoteAgeSec);
    return toE8(quote.price);
  };

const writeRefReport = (
  runtime: Runtime<Config>,
  evm: EVMClient,
  ticker: string,
  priceE8: bigint,
  sessionOpen: boolean,
  asOf: number,
): string => {
  const payloadHex = encodeReport({
    feedId: tickerToFeedId(ticker),
    priceE8,
    sessionOpen,
    asOf: BigInt(asOf),
  });
  const report = runtime
    .report({
      encodedPayload: hexToBase64(payloadHex),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  const res = evm
    .writeReport(runtime, {
      receiver: runtime.config.receiver,
      report,
      gasConfig: { gasLimit: runtime.config.gasLimit },
    })
    .result();

  if (res.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`${ticker}: tx ${res.txStatus}: ${res.errorMessage}`);
  }
  if (res.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.REVERTED) {
    throw new Error(`${ticker}: onReport() reverted`);
  }
  // Dry-run simulation (no --broadcast) returns an empty hash ("0x"), per docs.
  return res.txHash ? bytesToHex(res.txHash) : "0x";
};

const onCronTrigger = (runtime: Runtime<Config>, payload: CronPayload): string => {
  const cfg = runtime.config;
  // DON time: consensus-derived, identical on every node.
  const nowSec = Math.floor(runtime.now().getTime() / 1000);
  // forceSessionOpen is a DEMO-ONLY switch (replays a fixture outside US hours). Keep false in any real run.
  const session = cfg.forceSessionOpen
    ? { open: true, phase: "regular" as const, earlyClose: false, nyDate: "demo", minuteOfDay: 0 }
    : getSessionState(nowSec, cfg.sessionMode);
  runtime.log(
    `trigger scheduled=${payload.scheduledExecutionTime?.seconds}s now=${nowSec} ny=${session.nyDate} phase=${session.phase} open=${session.open}`,
  );

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainName });
  if (!network) throw new Error(`unknown chain: ${cfg.chainName}`);
  const evm = new EVMClient(network.chainSelector.selector);

  // UNVERIFIED: `.result().value` shape of getSecret (docs: runtime.getSecret({ id }).result()). Only needed for keyed providers.
  const apiKey = cfg.provider === "finnhub" ? runtime.getSecret({ id: "FINNHUB_API_KEY" }).result().value : undefined;

  const done: string[] = [];
  const failed: string[] = [];

  for (const { ticker } of cfg.feeds) {
    try {
      if (!session.open) {
        // Closed: thin out heartbeats; oracle/hook treat sessionOpen=false (or staleness) as "charge base fee".
        if (!isHeartbeatMinute(nowSec, cfg.closedHeartbeatMinutes)) continue;
        const tx = writeRefReport(runtime, evm, ticker, 0n, false, nowSec);
        done.push(`${ticker}:closed:${tx}`);
        continue;
      }

      let priceE8: bigint;
      try {
        priceE8 = runtime.runInNodeMode(makePriceFetcher(ticker, apiKey), consensusMedianAggregation<bigint>())().result();
      } catch (e) {
        if (cfg.onFetchFailure === "write_closed") {
          runtime.log(`${ticker}: consensus failed (${e}); writing sessionOpen=false`);
          const tx = writeRefReport(runtime, evm, ticker, 0n, false, nowSec);
          done.push(`${ticker}:fetch-failed->closed:${tx}`);
        } else {
          failed.push(`${ticker}: ${e}`); // stay silent; oracle ages out and the hook fails open
        }
        continue;
      }
      const tx = writeRefReport(runtime, evm, ticker, priceE8, true, nowSec);
      done.push(`${ticker}:${priceE8}:${tx}`);
    } catch (e) {
      failed.push(`${ticker}: ${e}`);
    }
  }

  runtime.log(`wrote=[${done.join(", ")}] failed=[${failed.join("; ")}]`);
  if (failed.length > 0 && done.length === 0 && session.open) throw new Error(`all feeds failed: ${failed.join("; ")}`);
  return `wrote ${done.length}, failed ${failed.length}`;
};

const initWorkflow = (config: Config) => {
  validateConfig(config);
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
