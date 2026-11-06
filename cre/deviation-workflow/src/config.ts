import type { SessionMode } from "./session.ts";
import type { Provider } from "./quote.ts";

export interface Config {
  schedule: string; // 6-field cron (sec min hour dom month dow), min interval 30s per CRE docs
  chainName: string; // CRE chain name, "arc-testnet"
  receiver: string; // deployed RefPriceOracle address (inherits ReceiverTemplate)
  gasLimit: string; // string, per CRE docs example ("500000")
  providers: Provider[]; // tried in order by every node; first fresh quote wins (finnhub needs the FINNHUB_API_KEY secret)
  sessionMode: SessionMode;
  maxQuoteAgeSec: number; // reject quotes older than this while the session is open
  closedHeartbeatMinutes: number; // when closed, write a sessionOpen=false report every N minutes; 0 = never (RefPriceOracle ignores priceE8==0 reports, so 0 is the useful setting)
  onFetchFailure: "skip" | "write_closed"; // all nodes failed: stay silent (oracle goes stale) or write closed
  feeds: Array<{ ticker: string }>;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * `allowZeroReceiver` exists only for unit tests and for config files that are shipped before the
 * oracle is deployed. The workflow entry point always validates strictly: run scripts/set-receiver.ts first.
 */
export function validateConfig(c: any, opts: { allowZeroReceiver?: boolean } = {}): Config {
  const fail = (m: string): never => {
    throw new Error(`config: ${m}`);
  };
  if (typeof c?.schedule !== "string" || c.schedule.trim().split(/\s+/).length < 5) fail("schedule must be a cron string");
  if (typeof c.chainName !== "string" || !c.chainName) fail("chainName required");
  if (typeof c.receiver !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(c.receiver)) fail("receiver must be a 20-byte hex address");
  if (!opts.allowZeroReceiver && c.receiver.toLowerCase() === ZERO_ADDRESS) {
    fail("receiver is the zero address: deploy RefPriceOracle, then run `bun run set-receiver` (reads deployments/<network>.json)");
  }
  if (typeof c.gasLimit !== "string" || !/^\d+$/.test(c.gasLimit)) fail("gasLimit must be a numeric string");
  if (!Array.isArray(c.providers) || c.providers.length === 0 || new Set(c.providers).size !== c.providers.length) {
    fail("providers must be a non-empty array of unique values");
  }
  for (const p of c.providers) if (p !== "yahoo" && p !== "finnhub") fail(`unknown provider ${JSON.stringify(p)} (yahoo|finnhub)`);
  if (c.sessionMode !== "regular" && c.sessionMode !== "extended") fail("sessionMode must be regular|extended");
  if (!Number.isInteger(c.maxQuoteAgeSec) || c.maxQuoteAgeSec < 10) fail("maxQuoteAgeSec must be an integer >= 10");
  if (!Number.isInteger(c.closedHeartbeatMinutes) || c.closedHeartbeatMinutes < 0) fail("closedHeartbeatMinutes must be an integer >= 0");
  if (c.onFetchFailure !== "skip" && c.onFetchFailure !== "write_closed") fail("onFetchFailure must be skip|write_closed");
  if (!Array.isArray(c.feeds) || c.feeds.length === 0) fail("feeds must be a non-empty array");
  for (const f of c.feeds) if (typeof f?.ticker !== "string" || !/^[A-Z0-9.\-]{1,12}$/.test(f.ticker)) fail(`bad feed ticker ${JSON.stringify(f)}`);
  return c as Config;
}
