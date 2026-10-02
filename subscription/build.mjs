// Compiles the contracts with solc 0.8.26 (optimizer on, 200 runs) and writes:
//   build/FizzlSubscription.json, build/MockUSDC.json   abi + bytecode, for tests and the wallet server
//   build/FizzlSubscription.input.json                  the standard-json input, for verifying on Basescan
//   ../wallet-server/src/subscription-artifact.json      a copy for the wallet server
// `node build.mjs --check` fails when the committed build is out of date.
import solc from "solc";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const SOURCES = ["FizzlSubscription.sol", "MockUSDC.sol"];
const input = {
  language: "Solidity",
  sources: Object.fromEntries(SOURCES.map((f) => [f, { content: readFileSync(new URL(`./contracts/${f}`, import.meta.url), "utf8") }])),
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors ?? []).filter((e) => e.severity === "error");
if (errors.length) { console.error(errors.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
for (const w of (out.errors ?? []).filter((e) => e.severity !== "error")) console.warn(w.formattedMessage);

const files = {};
for (const f of SOURCES) {
  const name = f.replace(".sol", "");
  const c = out.contracts[f][name];
  files[`${name}.json`] = `${JSON.stringify({ contractName: name, compiler: `solc ${solc.version()}`, abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` }, null, 2)}\n`;
}
const subscriptionInput = { ...input, sources: { "FizzlSubscription.sol": input.sources["FizzlSubscription.sol"] }, settings: { ...input.settings, outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] } } } };
files["FizzlSubscription.input.json"] = `${JSON.stringify(subscriptionInput, null, 2)}\n`;
// The wallet server deploys and talks to the contract with this copy.
const serverCopy = new URL("../wallet-server/src/subscription-artifact.json", import.meta.url);
const serverBody = files["FizzlSubscription.json"];

const dir = new URL("./build/", import.meta.url);
if (process.argv.includes("--check")) {
  const stale = Object.entries(files).filter(([f, body]) => !existsSync(new URL(f, dir)) || readFileSync(new URL(f, dir), "utf8") !== body).map(([f]) => f);
  if (!existsSync(serverCopy) || readFileSync(serverCopy, "utf8") !== serverBody) stale.push("wallet-server/src/subscription-artifact.json");
  if (stale.length) { console.error(`build is out of date: ${stale.join(", ")} (run npm run build)`); process.exit(1); }
  console.log("build is up to date");
} else {
  mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(new URL(f, dir), body);
  writeFileSync(serverCopy, serverBody);
  console.log(`built with solc ${solc.version()}`);
}
