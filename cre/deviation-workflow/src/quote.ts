// Pure quote parsing / URL building. No network, no SDK imports.
// Each parser returns {price, quoteTimeSec} or throws: in CRE a node that throws is dropped
// from consensus instead of contributing a bad number.

export type Provider = "yahoo" | "finnhub";

export interface Quote {
  price: number;
  quoteTimeSec: number;
}

/**
 * Candidate URLs for one provider, in the order a node should try them.
 * Yahoo has two public hosts serving the same v8 chart API; the second is a same-provider failover.
 * Finnhub needs an API key (CRE secret).
 */
export function buildQuoteUrls(provider: Provider, ticker: string, apiKey?: string): string[] {
  if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) throw new Error(`bad ticker: ${ticker}`);
  if (provider === "yahoo") {
    // interval=1m + includePrePost gives pre/post bars; last non-null bar close is the live price.
    const path = `/v8/finance/chart/${ticker}?interval=1m&range=1d&includePrePost=true`;
    return [`https://query1.finance.yahoo.com${path}`, `https://query2.finance.yahoo.com${path}`];
  }
  if (!apiKey) throw new Error("finnhub requires an API key");
  return [`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${encodeURIComponent(apiKey)}`];
}

/** Yahoo v8 chart. Uses the last non-null 1m bar (works in pre/post), falling back to meta. */
export function parseYahooChart(body: string): Quote {
  const j = JSON.parse(body);
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`yahoo: no result (${JSON.stringify(j?.chart?.error ?? null)})`);
  const ts: Array<number | null> = res.timestamp ?? [];
  const close: Array<number | null> = res.indicators?.quote?.[0]?.close ?? [];
  for (let i = Math.min(ts.length, close.length) - 1; i >= 0; i--) {
    const c = close[i];
    const t = ts[i];
    if (typeof c === "number" && Number.isFinite(c) && c > 0 && typeof t === "number") {
      return { price: c, quoteTimeSec: t };
    }
  }
  const p = res.meta?.regularMarketPrice;
  const t = res.meta?.regularMarketTime;
  if (typeof p === "number" && p > 0 && typeof t === "number") return { price: p, quoteTimeSec: t };
  throw new Error("yahoo: no usable price");
}

/** Finnhub /quote: {c: current price, t: unix seconds, ...}. (Field names from memory; unverified against docs.) */
export function parseFinnhubQuote(body: string): Quote {
  const j = JSON.parse(body);
  if (typeof j?.c !== "number" || !(j.c > 0) || typeof j?.t !== "number" || !(j.t > 0)) {
    throw new Error("finnhub: no usable quote");
  }
  return { price: j.c, quoteTimeSec: j.t };
}

export function parseQuote(provider: Provider, body: string): Quote {
  return provider === "yahoo" ? parseYahooChart(body) : parseFinnhubQuote(body);
}

export function assertFresh(q: Quote, nowSec: number, maxAgeSec: number): void {
  const age = nowSec - q.quoteTimeSec;
  if (age > maxAgeSec) throw new Error(`stale quote: ${age}s > ${maxAgeSec}s`);
  if (age < -60) throw new Error(`quote from the future: ${age}s`);
}
