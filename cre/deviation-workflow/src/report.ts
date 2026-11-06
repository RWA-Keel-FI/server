// Pure report encoding for RefPriceOracle.onReport.
// Layout == Solidity abi.encode(bytes32 feedId, uint64 priceE8, bool sessionOpen, uint64 asOf)
// All four params are static, so the encoding is exactly 4 x 32 bytes (128 bytes), no offsets.
// Hand-rolled (no viem) so it is unit-testable with plain node; test vectors cross-check the layout.

export interface RefReport {
  feedId: string; // 0x-prefixed 32-byte hex
  priceE8: bigint; // USD price * 1e8
  sessionOpen: boolean;
  asOf: bigint; // unix seconds
}

const U64_MAX = (1n << 64n) - 1n;

/** bytes32("NVDA") in Solidity terms: ASCII, left-aligned, zero right-padded. */
export function tickerToFeedId(ticker: string): string {
  if (!/^[A-Z0-9.\-]{1,32}$/.test(ticker)) throw new Error(`bad ticker: ${ticker}`);
  let hex = "";
  for (const ch of ticker) hex += ch.charCodeAt(0).toString(16).padStart(2, "0");
  return "0x" + hex.padEnd(64, "0");
}

/** Decimal USD price -> uint64 price * 1e8 without float error accumulating. */
export function toE8(price: number): bigint {
  if (!Number.isFinite(price) || price <= 0) throw new Error(`bad price: ${price}`);
  const s = price.toFixed(8); // e.g. "188.26000000"
  const v = BigInt(s.replace(".", ""));
  if (v > U64_MAX) throw new Error("price overflows uint64");
  return v;
}

const word = (v: bigint) => v.toString(16).padStart(64, "0");

export function encodeReport(r: RefReport): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(r.feedId)) throw new Error("feedId must be 32-byte hex");
  if (r.priceE8 < 0n || r.priceE8 > U64_MAX) throw new Error("priceE8 out of uint64 range");
  if (r.asOf < 0n || r.asOf > U64_MAX) throw new Error("asOf out of uint64 range");
  return "0x" + r.feedId.slice(2).toLowerCase() + word(r.priceE8) + word(r.sessionOpen ? 1n : 0n) + word(r.asOf);
}

export function decodeReport(hex: string): RefReport {
  if (!/^0x[0-9a-fA-F]{256}$/.test(hex)) throw new Error("report must be exactly 128 bytes");
  const b = hex.slice(2);
  const w = (i: number) => b.slice(i * 64, (i + 1) * 64);
  const open = BigInt("0x" + w(2));
  if (open > 1n) throw new Error("bool word out of range");
  return {
    feedId: "0x" + w(0),
    priceE8: BigInt("0x" + w(1)),
    sessionOpen: open === 1n,
    asOf: BigInt("0x" + w(3)),
  };
}
