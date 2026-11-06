import test from "node:test";
import assert from "node:assert/strict";
import { parseYahooChart, parseFinnhubQuote, buildQuoteUrl, assertFresh } from "../src/quote.ts";
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
  assert.match(buildQuoteUrl("yahoo", "NVDA"), /v8\/finance\/chart\/NVDA\?interval=1m/);
  assert.match(buildQuoteUrl("finnhub", "NVDA", "k e y"), /token=k%20e%20y$/);
  assert.throws(() => buildQuoteUrl("finnhub", "NVDA"));
  assert.throws(() => buildQuoteUrl("yahoo", "NVDA/../x"));
});

test("freshness guard", () => {
  assert.doesNotThrow(() => assertFresh({ price: 1, quoteTimeSec: 1000 }, 1100, 120));
  assert.throws(() => assertFresh({ price: 1, quoteTimeSec: 1000 }, 1200, 120), /stale/);
  assert.throws(() => assertFresh({ price: 1, quoteTimeSec: 2000 }, 1000, 120), /future/);
});

test("shipped config.staging.json validates", () => {
  const cfg = JSON.parse(readFileSync(new URL("../config.staging.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateConfig(cfg));
  assert.throws(() => validateConfig({ ...cfg, receiver: "0x123" }));
  assert.throws(() => validateConfig({ ...cfg, feeds: [] }));
  assert.throws(() => validateConfig({ ...cfg, provider: "bloomberg" }));
});

test("demo template replaces provider url; demo config validates", () => {
  assert.equal(buildQuoteUrl("yahoo", "NVDA", undefined, "http://127.0.0.1:8787/{ticker}.json"), "http://127.0.0.1:8787/NVDA.json");
  const demo = JSON.parse(readFileSync(new URL("../config.demo.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateConfig(demo));
  assert.throws(() => validateConfig({ ...demo, quoteUrlTemplate: "http://x/no-placeholder" }));
  assert.throws(() => validateConfig({ ...demo, forceSessionOpen: "yes" }));
});

test("fixtures parse with the yahoo parser", () => {
  for (const [t, p] of [["NVDA", 188.26], ["TSLA", 420.69]] as const) {
    const q = parseYahooChart(readFileSync(new URL(`../fixtures/${t}.json`, import.meta.url), "utf8"));
    assert.equal(q.price, p);
  }
});
