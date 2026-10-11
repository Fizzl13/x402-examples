// Paying x402 in USDC on Solana from the agent's own account (SOLANA_PRIVATE_KEY): the real @x402/svm client builds
// the payment against a local RPC, presign-guard (a stand-in) checks it first, the guarded signer signs only the
// agent's USDC transfer, and it counts toward the USDC limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import * as k from "@solana/kit";
import { generatePrivateKey } from "viem/accounts";
import { configFromEnv, createWallet, solanaKey, SOLANA } from "../lib.js";

const API = "https://sol-seller.example/data";
const SELLER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const FEE_PAYER = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const KEY = generatePrivateKey();

// A Solana RPC that knows one thing: the USDC mint (6 decimals, owned by the Token program).
async function fakeRpc() {
  const mint = Buffer.alloc(82); mint[44] = 6; mint[45] = 1;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const { id, method } = JSON.parse(body);
    const result = method === "getAccountInfo"
      ? { context: { slot: 1 }, value: { data: [mint.toString("base64"), "base64"], executable: false, lamports: 1461600, owner: TOKEN, rentEpoch: 0, space: 82 } }
      : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result ? { jsonrpc: "2.0", id, result } : { jsonrpc: "2.0", id, error: { code: -32601, message: method } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test("SOLANA_PRIVATE_KEY: base58 or a solana-keygen byte array, 64 bytes or the 32-byte seed; bad keys are refused", async () => {
  const seed = randomBytes(32);
  const kp = await k.createKeyPairSignerFromPrivateKeyBytes(seed);
  const full = Buffer.concat([seed, Buffer.from(k.getAddressEncoder().encode(kp.address))]);
  for (const text of [k.getBase58Decoder().decode(full), JSON.stringify([...full]), k.getBase58Decoder().decode(seed)]) {
    assert.equal(solanaKey(text).address, kp.address);
  }
  const cfg = configFromEnv({ AGENT_KEY: KEY, LIMIT_USDC_PER_TX: "1", SOLANA_PRIVATE_KEY: JSON.stringify([...full]), SOLANA_NETWORK: "devnet" });
  assert.deepEqual([cfg.solana.net, cfg.solana.address, cfg.solana.rpcUrl], ["devnet", kp.address, SOLANA.devnet.rpc]);
  const wrongHalf = Buffer.concat([seed, randomBytes(32)]);
  for (const bad of ["not a key", JSON.stringify([1, 2, 3]), k.getBase58Decoder().decode(wrongHalf)]) {
    assert.throws(() => configFromEnv({ AGENT_KEY: KEY, LIMIT_USDC_PER_TX: "1", SOLANA_PRIVATE_KEY: bad }), /SOLANA_PRIVATE_KEY/);
  }
  assert.throws(() => configFromEnv({ AGENT_KEY: KEY, LIMIT_USDC_PER_TX: "1", SOLANA_PRIVATE_KEY: k.getBase58Decoder().decode(seed), SOLANA_NETWORK: "testnet" }), /SOLANA_NETWORK/);
});

test("pays a Solana-only x402 offer: presign-guard checks it (type solana), only the agent signs, limits count it", async () => {
  const rpc = await fakeRpc();
  const net = SOLANA.mainnet;
  const checks = [], seen = [];
  const offer = (asset) => ({ scheme: "exact", network: net.network, amount: "10000", asset, payTo: SELLER, maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER, recentBlockhash: "11111111111111111111111111111111" } });
  const fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    if (url.startsWith("https://presign-guard.fizzl.eu/")) {
      checks.push(JSON.parse(input instanceof Request ? await input.text() : init.body));
      return Response.json({ verdict: "green", reasons: [] });
    }
    if (url === rpc.url) return Response.json({ jsonrpc: "2.0", id: 1, result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: "2500000" } } } } } }] } });
    if (url === API) {
      const sig = headers.get("payment-signature") ?? headers.get("x-payment");
      if (!sig) {
        // Another token first: the USDC offer is the one paid.
        const challenge = { x402Version: 2, error: "payment required", resource: { url: API, description: "data", mimeType: "application/json" }, accepts: [offer("So11111111111111111111111111111111111111112"), offer(net.usdc)] };
        return new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") } });
      }
      seen.push(JSON.parse(Buffer.from(sig, "base64").toString()));
      const receipt = Buffer.from(JSON.stringify({ success: true, transaction: "SOLSIG", network: net.network, payer: "x" })).toString("base64");
      return new Response(JSON.stringify({ answer: 45 }), { status: 200, headers: { "content-type": "application/json", "payment-response": receipt } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const seed = randomBytes(32);
  const kp = await k.createKeyPairSignerFromPrivateKeyBytes(seed, true);
  const cfg = configFromEnv({ AGENT_KEY: KEY, LIMIT_USDC_PER_TX: "1", LIMIT_USDC_PER_DAY: "5", SOLANA_PRIVATE_KEY: k.getBase58Decoder().decode(seed), SOLANA_RPC_URL: rpc.url });
  try {
    const wallet = createWallet(cfg, { fetch, guard: { verifyReceipts: "off" } });
    assert.equal(wallet.solanaAddress, kp.address);
    const out = await wallet.payX402({ url: API, method: "GET", reason: "solana test" });
    assert.equal(out.status, 200, out.body);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].accepted.asset, net.usdc, "the USDC offer was chosen");
    // presign-guard saw the transaction first, as the agent's.
    assert.equal(checks.length, 1);
    assert.deepEqual([checks[0].type, checks[0].from], ["solana", kp.address]);
    // The fee payer's signature is left open; the agent's is there and valid.
    const tx = k.getTransactionDecoder().decode(Buffer.from(seen[0].payload.transaction, "base64"));
    assert.equal(tx.signatures[FEE_PAYER], null);
    const pub = await crypto.subtle.importKey("raw", k.getAddressEncoder().encode(kp.address), "Ed25519", false, ["verify"]);
    assert.ok(await crypto.subtle.verify("Ed25519", pub, tx.signatures[kp.address], tx.messageBytes));
    const [row] = await wallet.guard.spending();
    assert.deepEqual([row.token, row.used], ["USDC", "0.01"]);
    const status = await wallet.status();
    assert.equal(status.solana.address, kp.address);
    assert.equal(status.solana.usdc, "2.5");
  } finally { rpc.close(); }
});
