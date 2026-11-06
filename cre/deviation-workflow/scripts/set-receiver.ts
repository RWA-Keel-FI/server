// Writes the deployed RefPriceOracle address from a deployment manifest into the workflow configs.
//
//   bun run set-receiver                      # ../../../deployments/arc-testnet.json -> config.staging.json + config.production.json
//   bun run set-receiver -- --fork            # ../../../deployments/arc-fork.json    -> config.fork.json
//   bun run set-receiver -- --manifest <path> --config <file> [--config <file> ...]
//
// Refuses to run when the manifest is missing or does not contain a plausible oracle address.
// Reads the address only; never touches keys.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wfDir = resolve(here, "..");
const deployments = resolve(wfDir, "../../../deployments");

const ARC_TESTNET_CHAIN_ID = 5042002;
const KNOWN_FORWARDERS: Record<string, string> = {
  "0x6e9ee680ef59ef64aa8c7371279c27e496b5edc1": "MockKeystoneForwarder (simulation only)",
  "0x76c9cf548b4179f8901cda1f8623568b58215e62": "KeystoneForwarder (production)",
};
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

function die(msg: string): never {
  console.error(`set-receiver: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const fork = args.includes("--fork");
const flagValues = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const manifestPath = resolve(flagValues("--manifest")[0] ?? `${deployments}/${fork ? "arc-fork" : "arc-testnet"}.json`);
const configs = (flagValues("--config").length ? flagValues("--config") : fork ? ["config.fork.json"] : ["config.staging.json", "config.production.json"]).map(
  (c) => resolve(wfDir, c),
);

if (!existsSync(manifestPath)) {
  die(`manifest not found: ${manifestPath}\n  Deploy the contracts first (the contracts agent/owner writes deployments/${fork ? "arc-fork" : "arc-testnet"}.json).`);
}
let manifest: any;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
  die(`manifest is not valid JSON: ${manifestPath} (${e})`);
}

const oracle: unknown = manifest.oracle ?? manifest.refPriceOracle;
if (typeof oracle !== "string" || !ADDR.test(oracle) || oracle.toLowerCase() === ZERO) {
  die(`manifest has no valid "oracle" address (got ${JSON.stringify(oracle)})`);
}
if (manifest.chainId !== undefined && manifest.chainId !== ARC_TESTNET_CHAIN_ID) {
  die(`manifest chainId is ${manifest.chainId}, expected ${ARC_TESTNET_CHAIN_ID} (Arc Testnet; a fork keeps that id)`);
}
const fwd = typeof manifest.forwarder === "string" ? KNOWN_FORWARDERS[manifest.forwarder.toLowerCase()] : undefined;
if (typeof manifest.forwarder === "string" && !fwd) {
  console.warn(`warning: manifest forwarder ${manifest.forwarder} is not a known arc-testnet forwarder; reports from CRE will be rejected by the oracle.`);
}

for (const file of configs) {
  if (!existsSync(file)) die(`config not found: ${file}`);
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  const before = cfg.receiver;
  cfg.receiver = oracle;
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`${file}: receiver ${before} -> ${oracle}`);
}
console.log(`oracle forwarder in manifest: ${manifest.forwarder ?? "(not recorded)"}${fwd ? ` = ${fwd}` : ""}`);
if (fwd?.startsWith("Mock")) {
  console.log("note: simulate with this forwarder; before `cre workflow deploy`, the oracle owner must call setForwarderAddress(0x76c9cf548b4179F8901cda1f8623568b58215E62).");
} else if (fwd?.startsWith("Keystone")) {
  console.log("note: this oracle trusts the PRODUCTION forwarder; `cre workflow simulate --broadcast` will be rejected by it (use a mock-forwarder oracle for simulation).");
}
