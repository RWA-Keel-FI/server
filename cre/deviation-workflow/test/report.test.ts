import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { encodeReport, decodeReport, tickerToFeedId, toE8 } from "../src/report.ts";

// Reference vector produced by: cast abi-encode "f(bytes32,uint64,bool,uint64)" 0x4e564441.. 18826000000 true 1793995148
const NVDA_VECTOR =
  "0x4e5644410000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004621df6800000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000006aee318c";

test("tickerToFeedId == Solidity bytes32('NVDA')", () => {
  assert.equal(tickerToFeedId("NVDA"), "0x4e56444100000000000000000000000000000000000000000000000000000000");
  assert.equal(tickerToFeedId("BRK.B").length, 66);
  assert.throws(() => tickerToFeedId("nvda"));
  assert.throws(() => tickerToFeedId(""));
});

test("toE8 is exact for typical prices", () => {
  assert.equal(toE8(188.26), 18826000000n);
  assert.equal(toE8(188.25999450683594), 18825999451n);
  assert.equal(toE8(0.1 + 0.2), 30000000n);
  assert.throws(() => toE8(0));
  assert.throws(() => toE8(-1));
  assert.throws(() => toE8(NaN));
});

test("encodeReport matches the cast abi-encode vector (128 bytes)", () => {
  const hex = encodeReport({ feedId: tickerToFeedId("NVDA"), priceE8: 18826000000n, sessionOpen: true, asOf: 1793995148n });
  assert.equal(hex.length, 2 + 128 * 2);
  assert.equal(hex, NVDA_VECTOR);
});

test("encode/decode roundtrip, closed heartbeat has price 0", () => {
  const r = { feedId: tickerToFeedId("TSLA"), priceE8: 0n, sessionOpen: false, asOf: 1793995200n };
  assert.deepEqual(decodeReport(encodeReport(r)), r);
});

test("range checks", () => {
  const ok = { feedId: tickerToFeedId("SPY"), priceE8: 1n, sessionOpen: true, asOf: 1n };
  assert.throws(() => encodeReport({ ...ok, priceE8: 1n << 64n }));
  assert.throws(() => encodeReport({ ...ok, asOf: -1n }));
  assert.throws(() => encodeReport({ ...ok, feedId: "0x1234" }));
  assert.throws(() => decodeReport("0x00"));
});

const hasCast = (() => {
  try {
    execFileSync("cast", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("cross-check with foundry's cast when installed", { skip: !hasCast && "cast not available" }, () => {
  const out = execFileSync(
    "cast",
    ["abi-encode", "f(bytes32,uint64,bool,uint64)", tickerToFeedId("TSLA"), "42069000000", "false", "1793995200"],
    { encoding: "utf8" },
  ).trim();
  assert.equal(encodeReport({ feedId: tickerToFeedId("TSLA"), priceE8: 42069000000n, sessionOpen: false, asOf: 1793995200n }), out);
});
