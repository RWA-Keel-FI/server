import test from "node:test";
import assert from "node:assert/strict";
import { parseYahooChart, parseFinnhubQuote, buildQuoteUrls, assertFresh } from "../src/quote.ts";
import { validateConfig } from "../src/config.ts";
import { readFileSync } from "node:fs";

test("yahoo: last non-null bar wins, nulls skipped", () => {
  const body = JSON.stringify({
    chart: { result: [{ timestamp: [100, 160, 220], indicators: { quote: [{ close: [10, 11, null] }] }, meta: { regularMarketPrice: 9, regularMarketTime: 90 } }] },
  });
  assert.deepEqual(parseYahooChart(body), { price: 11, quoteTimeSec: 160 });
});

test("yahoo: falls back to meta, errors otherwise", () => {
  const meta = JSON.stringify({ chart: { result: [{ timestamp: [], indicators: { quote: [{ close: [] }] }, meta: { regularMarketPrice: 9.5, regularMarketTime: 90 } }] } });
  assert.deepEqual(parseYahooChart(meta), { price: 9.5, quoteTimeSec: 90 });
  assert.throws(() => parseYahooChart(JSON.stringify({ chart: { result: null, error: { code: "Not Found" } } })));
  assert.throws(() => parseYahooChart("not json"));
});

test("finnhub: parses c/t, rejects zeros (unknown symbol returns zeros)", () => {
  assert.deepEqual(parseFinnhubQuote('{"c":188.2,"t":1793995148}'), { price: 188.2, quoteTimeSec: 1793995148 });
  assert.throws(() => parseFinnhubQuote('{"c":0,"d":null,"t":0}'));
});

test("url building + ticker validation", () => {
  const y = buildQuoteUrls("yahoo", "TSLA");
  assert.equal(y.length, 2); // query1 then query2 failover
  assert.match(y[0], /^https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/TSLA\?interval=1m/);
  assert.match(y[1], /^https:\/\/query2\./);
  assert.match(buildQuoteUrls("finnhub", "TSLA", "k e y")[0], /token=k%20e%20y$/);
  assert.throws(() => buildQuoteUrls("finnhub", "TSLA"));
  assert.throws(() => buildQuoteUrls("yahoo", "TSLA/../x"));
});

test("freshness guard", () => {
  assert.doesNotThrow(() => assertFresh({ price: 1, quoteTimeSec: 1000 }, 1100, 120));
  assert.throws(() => assertFresh({ price: 1, quoteTimeSec: 1000 }, 1200, 120), /stale/);
  assert.throws(() => assertFresh({ price: 1, quoteTimeSec: 2000 }, 1000, 120), /future/);
});

const ZERO = "0x0000000000000000000000000000000000000000";
const shipped = (n: string) => JSON.parse(readFileSync(new URL(`../config.${n}.json`, import.meta.url), "utf8"));

test("shipped configs: arc-testnet, known stock feeds only, real providers only, receiver is a real address", () => {
  for (const n of ["staging", "production", "fork"]) {
    const cfg = shipped(n);
    // staging/production: set-receiver has written the deployed oracle, so strict validation passes. fork keeps the zero address
    // until `set-receiver --fork` runs against a local fork.
    assert.doesNotThrow(() => validateConfig(cfg, { allowZeroReceiver: n === "fork" }), n);
    assert.equal(cfg.chainName, "arc-testnet");
    assert.deepEqual(cfg.feeds.map((f: { ticker: string }) => f.ticker), ["TSLA", "NVDA", "AAPL", "GOOGL", "META"]);
    if (n !== "fork") assert.notEqual(cfg.receiver, ZERO);
    assert.equal(cfg.forceSessionOpen, undefined);
    assert.equal(cfg.quoteUrlTemplate, undefined);
  }
});

test("validateConfig rejects the zero receiver unless explicitly allowed (the workflow entry point never allows it)", () => {
  const cfg = { ...shipped("staging"), receiver: ZERO }; // the shipped file has a real receiver; force the zero case
  assert.throws(() => validateConfig(cfg), /zero address/);
  assert.doesNotThrow(() => validateConfig({ ...cfg, receiver: "0x76c9cf548b4179F8901cda1f8623568b58215E62" }));
  assert.throws(() => validateConfig({ ...cfg, receiver: "0x123" }, { allowZeroReceiver: true }));
  assert.throws(() => validateConfig({ ...cfg, feeds: [] }, { allowZeroReceiver: true }));
  assert.throws(() => validateConfig({ ...cfg, providers: ["bloomberg"] }, { allowZeroReceiver: true }));
  assert.throws(() => validateConfig({ ...cfg, providers: [] }, { allowZeroReceiver: true }));
  assert.throws(() => validateConfig({ ...cfg, providers: ["yahoo", "yahoo"] }, { allowZeroReceiver: true }));
  assert.doesNotThrow(() => validateConfig({ ...cfg, providers: ["yahoo", "finnhub"], receiver: "0x76c9cf548b4179F8901cda1f8623568b58215E62" }));
});
