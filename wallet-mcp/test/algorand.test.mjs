// Paying x402 in USDC on Algorand from the agent's own account (ALGORAND_MNEMONIC): the real @x402/avm client
// builds the payment group against a local algod, the guarded signer signs only the agent's USDC transfer, and
// it counts toward the USDC limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mnemonicFromSeed } from "@algorandfoundation/algokit-utils/algo25";
import { decodeUnsignedTransaction, decodeSignedTransaction } from "@x402/avm";
import { randomBytes } from "node:crypto";
import { configFromEnv, createWallet, algorandKeyFromMnemonic, ALGORAND } from "../lib.js";
import * as guardWalletPkg from "presign-guard-wallet";

const API = "https://algo-seller.example/data";
const SELLER = "SGLTUPAC7TKGKNNXKNPQ2QZCC7NJSLAKYZ7O7NOGGAPXWBFZTOLTPMSPPI";
const FEE_PAYER = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
const KEY = generatePrivateKey();

async function fakeAlgod() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/v2/transactions/params")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ "consensus-version": "future", fee: 0, "genesis-hash": Buffer.alloc(32, 7).toString("base64"), "genesis-id": "testnet-v1.0", "last-round": 1000, "min-fee": 1000 }));
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test("ALGORAND_MNEMONIC: the key and address come from the 25 words; a bad mnemonic is refused", () => {
  const mnemonic = mnemonicFromSeed(randomBytes(32));
  const b64 = algorandKeyFromMnemonic(mnemonic);
  assert.equal(Buffer.from(b64, "base64").length, 64);
  const cfg = configFromEnv({ AGENT_KEY: KEY, LIMIT_USDC_PER_TX: "1", ALGORAND_MNEMONIC: mnemonic, ALGORAND_NETWORK: "testnet" });
  assert.equal(cfg.algorand.net, "testnet");
  assert.throws(() => configFromEnv({ AGENT_KEY: KEY, LIMIT_USDC_PER_TX: "1", ALGORAND_MNEMONIC: "not twenty five words" }), /ALGORAND_MNEMONIC/);
  assert.throws(() => configFromEnv({ AGENT_KEY: KEY, LIMIT_USDC_PER_TX: "1", ALGORAND_MNEMONIC: mnemonic, ALGORAND_NETWORK: "betanet" }), /ALGORAND_NETWORK/);
});

test("pays an Algorand-only x402 offer: only the agent's USDC transfer is signed, the fee payer's left open, limits count it", async () => {
  const algod = await fakeAlgod();
  const net = ALGORAND.testnet;
  const seen = [];
  const fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    if (url === API) {
      const sig = headers.get("payment-signature") ?? headers.get("x-payment");
      const accepts = [
        { scheme: "exact", network: net.network, amount: "10000", asset: String(net.usdc), payTo: SELLER, maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER, decimals: 6 } },
        { scheme: "exact", network: net.network, amount: "10000", asset: "123", payTo: SELLER, maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER } },
      ];
      if (!sig) {
        const challenge = { x402Version: 2, error: "payment required", resource: { url: API, description: "data", mimeType: "application/json" }, accepts: [accepts[1], accepts[0]] };
        return new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") } });
      }
      seen.push(JSON.parse(Buffer.from(sig, "base64").toString()));
      const receipt = Buffer.from(JSON.stringify({ success: true, transaction: "ALGOTXID", network: net.network, payer: "x" })).toString("base64");
      return new Response(JSON.stringify({ answer: 44 }), { status: 200, headers: { "content-type": "application/json", "payment-response": receipt } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const mnemonic = mnemonicFromSeed(randomBytes(32));
  const spends = [];
  const cfg = configFromEnv({ AGENT_KEY: KEY, LIMIT_USDC_PER_TX: "1", LIMIT_USDC_PER_DAY: "5", ALGORAND_MNEMONIC: mnemonic, ALGORAND_NETWORK: "testnet", ALGORAND_ALGOD_URL: algod.url });
  if (!guardWalletPkg.ALGORAND_USDC) {
    // Installed presign-guard-wallet is older than 0.12: a clear error instead of silently not paying on Algorand.
    algod.close();
    assert.throws(() => createWallet(cfg, { fetch }), /presign-guard-wallet 0\.12/);
    return;
  }
  try {
    const wallet = createWallet(cfg, { fetch, guard: { verifyReceipts: "off", onSpend: (e) => spends.push(e) } });
    const out = await wallet.payX402({ url: API, method: "GET", reason: "algorand test" });
    assert.equal(out.status, 200, out.body);
    assert.equal(seen.length, 1);
    const p = seen[0];
    assert.equal(p.accepted.network, net.network);
    assert.equal(String(p.accepted.asset), String(net.usdc), "the USDC offer was chosen, not asset 123");
    const group = p.payload.paymentGroup;
    assert.equal(group.length, 2);
    // [0] the fee payer's transaction, unsigned; [1] the agent's USDC transfer, signed.
    assert.equal(decodeUnsignedTransaction(group[0]).sender.toString(), FEE_PAYER);
    const signed = decodeSignedTransaction(group[1]);
    assert.ok(signed.sig, "the agent's transfer carries a signature");
    assert.equal(signed.txn.sender.toString(), wallet.algorandAddress);
    assert.equal(signed.txn.assetTransfer.receiver.toString(), SELLER);
    assert.equal(signed.txn.assetTransfer.assetId, BigInt(net.usdc));
    const [row] = await wallet.guard.spending();
    assert.deepEqual([row.token, row.used], ["USDC", "0.01"]);
  } finally { algod.close(); }
});
