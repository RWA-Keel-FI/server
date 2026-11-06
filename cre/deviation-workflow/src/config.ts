import type { SessionMode } from "./session.ts";
import type { Provider } from "./quote.ts";

export interface Config {
  schedule: string; // 6-field cron (sec min hour dom month dow), min interval 30s per CRE docs
  chainName: string; // CRE chain name, e.g. "ethereum-testnet-sepolia-unichain-1"
  receiver: string; // deployed RefPriceOracle address (inherits ReceiverTemplate)
  gasLimit: string; // string, per CRE docs example ("500000")
  provider: Provider;
  sessionMode: SessionMode;
  maxQuoteAgeSec: number; // reject quotes older than this while the session is open
  closedHeartbeatMinutes: number; // when closed, write a sessionOpen=false report every N minutes
  onFetchFailure: "skip" | "write_closed"; // all nodes failed: stay silent (oracle goes stale) or write closed
  feeds: Array<{ ticker: string }>;
  // DEMO-ONLY: replay a recorded quote outside US hours / when the provider is unreachable.
  forceSessionOpen?: boolean;
  quoteUrlTemplate?: string; // must contain "{ticker}"
}

export function validateConfig(c: any): Config {
  const fail = (m: string): never => {
    throw new Error(`config: ${m}`);
  };
  if (typeof c?.schedule !== "string" || c.schedule.trim().split(/\s+/).length < 5) fail("schedule must be a cron string");
  if (typeof c.chainName !== "string" || !c.chainName) fail("chainName required");
  if (typeof c.receiver !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(c.receiver)) fail("receiver must be a 20-byte hex address");
  if (typeof c.gasLimit !== "string" || !/^\d+$/.test(c.gasLimit)) fail("gasLimit must be a numeric string");
  if (c.provider !== "yahoo" && c.provider !== "finnhub") fail("provider must be yahoo|finnhub");
  if (c.sessionMode !== "regular" && c.sessionMode !== "extended") fail("sessionMode must be regular|extended");
  if (!Number.isInteger(c.maxQuoteAgeSec) || c.maxQuoteAgeSec < 10) fail("maxQuoteAgeSec must be an integer >= 10");
  if (!Number.isInteger(c.closedHeartbeatMinutes) || c.closedHeartbeatMinutes < 1) fail("closedHeartbeatMinutes must be an integer >= 1");
  if (c.onFetchFailure !== "skip" && c.onFetchFailure !== "write_closed") fail("onFetchFailure must be skip|write_closed");
  if (!Array.isArray(c.feeds) || c.feeds.length === 0) fail("feeds must be a non-empty array");
  for (const f of c.feeds) if (typeof f?.ticker !== "string" || !/^[A-Z0-9.\-]{1,12}$/.test(f.ticker)) fail(`bad feed ticker ${JSON.stringify(f)}`);
  if (c.forceSessionOpen !== undefined && typeof c.forceSessionOpen !== "boolean") fail("forceSessionOpen must be boolean");
  if (c.quoteUrlTemplate !== undefined && !(typeof c.quoteUrlTemplate === "string" && /^https?:\/\/.+\{ticker\}/.test(c.quoteUrlTemplate))) {
    fail('quoteUrlTemplate must be an http(s) URL containing "{ticker}"');
  }
  return c as Config;
}
