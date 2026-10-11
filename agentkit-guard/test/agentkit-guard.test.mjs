import { test } from "node:test";
import assert from "node:assert/strict";
import { EvmWalletProvider } from "@coinbase/agentkit";
import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import { guardWalletProvider, walletGuardActionProvider, PresignBlockedError } from "../index.js";

// AgentKit reports each action to Coinbase analytics; tests stay offline.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).startsWith("https://cca-lite.coinbase.com/") ? new Response("{}") : realFetch(url, init));

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SHOP = "0x1111111111111111111111111111111111111111";
const DRAINER = "0x2222222222222222222222222222222222222222";

// A stand-in for CdpEvmWalletProvider / ViemWalletProvider: records what it signs.
// The private field makes sure the guard calls methods on the real instance.
class FakeProvider extends EvmWalletProvider {
  #signed = [];
  get signed() { return this.#signed; }
  trackInitialization() {} // AgentKit's own analytics call: not in offline tests
  getAddress() { return "0x9999999999999999999999999999999999999999"; }
  getNetwork() { return { protocolFamily: "evm", networkId: "base-mainnet", chainId: "8453" }; }
  getName() { return "fake_wallet_provider"; }
  async getBalance() { return 0n; }
  async sign(hash) { this.#signed.push(["sign", hash]); return "0xsig"; }
  async signMessage(m) { this.#signed.push(["signMessage", m]); return "0xmsg"; }
  async signTypedData(t) { this.#signed.push(["signTypedData", t.primaryType]); return "0xtyped"; }
  async signTransaction(tx) { this.#signed.push(["signTransaction", tx.to, Object.getOwnPropertySymbols(tx).length]); return "0xraw"; }
  async sendTransaction(tx) { this.#signed.push(["sendTransaction", tx.to, tx.value ?? 0n]); return "0xhash"; }
  async waitForTransactionReceipt() { return { transactionHash: "0xhash" }; }
  async readContract() { return 0n; }
  getPublicClient() { return { request: async ({ method }) => `public:${method}` }; }
  async nativeTransfer(to, value) { return this.sendTransaction({ to, value: BigInt(value) }); } // unguarded original
  getClient() { return { evm: {} }; }
}

// presign-guard answers from a list: red for the drainer, green otherwise.
function presign() {
  const calls = [];
  const pay = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const target = body.to ?? body.typedData?.domain?.verifyingContract;
    const red = target === DRAINER || JSON.stringify(body).toLowerCase().includes(DRAINER.slice(2));
    return new Response(JSON.stringify({ verdict: red ? "red" : "green", reasons: red ? [{ code: "known_drainer", message: "known drainer" }] : [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { pay, calls };
}

const transfer = (to, usdc) => ({ to: USDC_BASE, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, parseUnits(usdc, 6)] }) });
const permit = (spender) => ({
  domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE },
  types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  primaryType: "Permit",
  message: { owner: "0x9999999999999999999999999999999999999999", spender, value: 1_000_000n, nonce: 0n, deadline: 9_999_999_999n },
});

function setup(options = {}) {
  const inner = new FakeProvider();
  const p = presign();
  const wallet = guardWalletProvider(inner, { pay: p.pay, verifyReceipts: "off", ...options });
  return { inner, wallet, calls: p.calls };
}

test("green transactions are checked, then signed by the real provider", async () => {
  const { inner, wallet, calls } = setup();
  assert.equal(await wallet.sendTransaction(transfer(SHOP, "2")), "0xhash");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "transaction");
  assert.equal(calls[0].chainId, 8453);
  assert.equal(calls[0].from, inner.getAddress()); // so presign-guard simulates it
  assert.deepEqual(inner.signed, [["sendTransaction", USDC_BASE, 0n]]);
  await wallet.signTypedData(permit(SHOP));
  assert.equal(calls[1].from, undefined);
});

test("red is never signed, and the agent gets the reason", async () => {
  const { inner, wallet } = setup();
  await assert.rejects(wallet.sendTransaction(transfer(DRAINER, "1")), (e) => e instanceof PresignBlockedError && e.code === "red" && /known_drainer/.test(e.message));
  await assert.rejects(wallet.signTypedData(permit(DRAINER)), (e) => e.code === "red");
  assert.deepEqual(inner.signed, []);
});

test("the provider still looks like the original to AgentKit", async () => {
  const { inner, wallet } = setup();
  assert.ok(wallet instanceof EvmWalletProvider);
  assert.equal(wallet.getAddress(), inner.getAddress());
  assert.equal(wallet.getName(), "fake_wallet_provider");
  assert.equal(await wallet.readContract({}), 0n);
  assert.equal(wallet.signed, inner.signed); // getters and private fields still work
});

test("nativeTransfer goes through the guard (the provider's own would not)", async () => {
  const { inner, wallet, calls } = setup();
  await wallet.nativeTransfer(SHOP, "1000");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value, "1000");
  assert.deepEqual(inner.signed, [["sendTransaction", SHOP, 1000n]]);
  await assert.rejects(wallet.nativeTransfer(DRAINER, "1"), /red/);
});

test("signTransaction is checked and the internal flag never reaches the provider", async () => {
  const { inner, wallet, calls } = setup();
  assert.equal(await wallet.signTransaction({ to: SHOP, value: 5n }), "0xraw");
  assert.equal(calls.length, 1);
  assert.deepEqual(inner.signed, [["signTransaction", SHOP, 0]]);
  await assert.rejects(wallet.signTransaction({ to: DRAINER }), /red/);
});

test("toSigner (used by the x402 actions) and toEip1193Provider are guarded too", async () => {
  const { inner, wallet, calls } = setup();
  const signer = wallet.toSigner();
  assert.equal(await signer.signTypedData(permit(SHOP)), "0xtyped");
  await assert.rejects(signer.signTypedData(permit(DRAINER)), /red/);
  if (EvmWalletProvider.prototype.toEip1193Provider) { // AgentKit 0.11+
    const eip = wallet.toEip1193Provider();
    await assert.rejects(eip.request({ method: "eth_sendTransaction", params: [{ to: DRAINER, value: "0x1" }] }), /red/);
    assert.deepEqual(await eip.request({ method: "eth_accounts" }), [inner.getAddress()]);
    assert.equal(await eip.request({ method: "eth_blockNumber" }), "public:eth_blockNumber");
    assert.equal(calls.length, 3);
  } else assert.equal(wallet.toEip1193Provider, undefined);
  assert.deepEqual(inner.signed, [["signTypedData", "Permit"]]);
});

test("raw hash signing and the CDP client are refused unless allowed", async () => {
  const { inner, wallet } = setup();
  await assert.rejects(wallet.sign("0xabc"), (e) => e.code === "unchecked");
  await assert.rejects(wallet.toSigner().sign({ hash: "0xabc" }), (e) => e.code === "unchecked");
  assert.throws(() => wallet.getClient(), (e) => e.code === "unchecked");
  assert.deepEqual(inner.signed, []);
  const open = setup({ allowRawSign: true, allowUnguardedClient: true }).wallet;
  assert.equal(await open.sign("0xabc"), "0xsig");
  assert.deepEqual(open.getClient(), { evm: {} });
});

test("limits: under is signed, over waits for the owner, a no is not signed", async () => {
  const asked = [];
  let answer = true;
  const { inner, wallet } = setup({ limits: { tokens: { USDC: { perTx: "5", perDay: "20" } } }, onOverLimit: async (info) => { asked.push(info); return answer; } });
  await wallet.sendTransaction(transfer(SHOP, "4"));
  assert.equal(asked.length, 0);
  await wallet.sendTransaction(transfer(SHOP, "8"));
  assert.equal(asked.length, 1);
  answer = false;
  await assert.rejects(wallet.sendTransaction(transfer(SHOP, "9")), (e) => e.code === "over_limit");
  assert.equal(inner.signed.length, 2);
  const usdc = (await wallet.guard.spending()).find((r) => r.token === "USDC");
  assert.ok(usdc, "spending has a USDC row");
});

test("pause stops everything until resume", async () => {
  const { inner, wallet } = setup();
  wallet.guard.pause();
  assert.equal(wallet.guard.paused(), true);
  await assert.rejects(wallet.sendTransaction(transfer(SHOP, "1")), (e) => e.code === "paused");
  await assert.rejects(wallet.nativeTransfer(SHOP, "1"), (e) => e.code === "paused");
  wallet.guard.resume();
  await wallet.sendTransaction(transfer(SHOP, "1"));
  assert.equal(inner.signed.length, 1);
});

test("the agent's actions: see the budget, pause itself", async () => {
  const { wallet } = setup({ limits: { tokens: { USDC: { perTx: "5", perDay: "20" } } } });
  const provider = walletGuardActionProvider();
  const actions = provider.getActions(wallet);
  const byName = Object.fromEntries(actions.map((a) => [a.name.replace(/^.*_(get_spending_limits|pause_spending)$/, "$1"), a]));
  assert.ok(byName.get_spending_limits && byName.pause_spending, actions.map((a) => a.name).join(", "));
  const limits = JSON.parse(await byName.get_spending_limits.invoke({}));
  assert.equal(limits.paused, false);
  assert.ok(limits.limits.some((r) => r.token === "USDC"));
  assert.match(await byName.pause_spending.invoke({ reason: "unexpected approve request" }), /Paused/);
  assert.equal(wallet.guard.paused(), true);
  const plain = walletGuardActionProvider().getActions(new FakeProvider());
  assert.match(await plain[0].invoke({}), /no spending guard/);
});

test("other providers are refused; a Solana provider needs the methods and a covered network", () => {
  assert.throws(() => guardWalletProvider({ getNetwork: () => ({ protocolFamily: "svm" }) }, { pay: async () => {} }), /EVM or Solana/);
  assert.throws(() => guardWalletProvider({ getNetwork: () => ({ protocolFamily: "bitcoin" }) }, { pay: async () => {} }), /EVM or Solana/);
  assert.throws(() => guardWalletProvider(new FakeProvider(), {}), /pay is required/);
});

test("works on AgentKit's real ViemWalletProvider (private fields, local key)", async () => {
  const { ViemWalletProvider } = await import("@coinbase/agentkit");
  const { createWalletClient, http } = await import("viem");
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const { base } = await import("viem/chains");
  const account = privateKeyToAccount(generatePrivateKey());
  const viemProvider = new ViemWalletProvider(createWalletClient({ account, chain: base, transport: http("http://127.0.0.1:9") }));
  viemProvider.trackInitialization = () => {};
  const p = presign();
  const wallet = guardWalletProvider(viemProvider, { pay: p.pay, verifyReceipts: "off" });
  assert.equal(wallet.getAddress(), account.address);
  assert.match(await wallet.signTypedData(permit(SHOP)), /^0x[0-9a-f]{130}$/);
  await assert.rejects(wallet.signTypedData(permit(DRAINER)), (e) => e.code === "red");
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[0].chainId, 8453);
});

test("the offline demo runs and shows green, red, over the limit and paused", async () => {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, [new URL("../example/demo.mjs", import.meta.url).pathname], { encoding: "utf8" });
  assert.match(out, /✓ signed: 0x/);
  assert.match(out, /not signed \(red\): not signed: red \(known_drainer\)/);
  assert.match(out, /not signed \(over_limit\)/);
  assert.match(out, /not signed \(paused\)/);
});

// ---- Solana ----
import { createRequire } from "node:module";
import { dirname } from "node:path";
const here = createRequire(import.meta.url);
const web3 = here(here.resolve("@solana/web3.js", { paths: [dirname(here.resolve("@coinbase/agentkit"))] }));
const { SolanaKeypairWalletProvider, SvmWalletProvider } = await import("@coinbase/agentkit");
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const OTHER = new web3.PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");

// presign-guard for Solana: a fixed verdict, with the simulation the wallet counts from.
function solPresign({ verdict = "green", simulation } = {}) {
  const calls = [];
  const pay = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return Response.json({ verdict, reasons: verdict === "green" ? [] : [{ code: "SOLANA_TOKEN_ACCOUNT_TAKEOVER", severity: verdict }], ...(simulation && { simulation }) });
  };
  return { pay, calls };
}
const solOut = (from, lamports) => ({ ok: true, fee: 0.000005, changes: [{ type: "sol", account: from, change: -lamports / 1e9, lamports: String(-lamports - 5000) }] });
const transferTx = (from, lamports = 1000n) => new web3.VersionedTransaction(web3.MessageV0.compile({
  payerKey: from, recentBlockhash: "11111111111111111111111111111111",
  instructions: [web3.SystemProgram.transfer({ fromPubkey: from, toPubkey: OTHER, lamports })],
}));
async function verifies(tx, pubkey) {
  const key = await crypto.subtle.importKey("raw", pubkey.toBytes(), "Ed25519", false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, tx.signatures[0], tx.message.serialize());
}

function keypairWallet(options = {}) {
  const keypair = web3.Keypair.generate();
  const inner = new SolanaKeypairWalletProvider({ keypair: keypair.secretKey, rpcUrl: "http://127.0.0.1:9", genesisHash: MAINNET_GENESIS });
  const p = solPresign(options.presign);
  const wallet = guardWalletProvider(inner, { pay: p.pay, verifyReceipts: "off", ...options.guard });
  return { keypair, inner, wallet, calls: p.calls };
}

test("Solana: AgentKit's keypair wallet signs only after presign-guard (type solana, from the wallet); red is not signed", async () => {
  const { keypair, wallet, calls } = keypairWallet();
  assert.ok(wallet instanceof SvmWalletProvider, "still a Solana wallet provider to AgentKit's actions");
  const signed = await wallet.signTransaction(transferTx(keypair.publicKey));
  assert.ok(await verifies(signed, keypair.publicKey));
  assert.deepEqual([calls[0].type, calls[0].from], ["solana", keypair.publicKey.toBase58()]);
  assert.ok(Buffer.from(calls[0].transaction, "base64").length > 100);

  const red = keypairWallet({ presign: { verdict: "red" } });
  const tx = transferTx(red.keypair.publicKey);
  await assert.rejects(red.wallet.signTransaction(tx), (e) => e instanceof PresignBlockedError && e.code === "red");
  assert.ok(tx.signatures[0].every((b) => b === 0), "nothing was signed");
});

test("Solana: what the simulation shows leaving counts toward a SOL limit; over it nothing is signed", async () => {
  const keypair = web3.Keypair.generate();
  const from = keypair.publicKey.toBase58();
  for (const [lamports, ok] of [[300_000_000, true], [700_000_000, false]]) {
    const inner = new SolanaKeypairWalletProvider({ keypair: keypair.secretKey, rpcUrl: "http://127.0.0.1:9", genesisHash: MAINNET_GENESIS });
    const p = solPresign({ simulation: solOut(from, lamports) });
    const wallet = guardWalletProvider(inner, { pay: p.pay, verifyReceipts: "off", limits: { tokens: { SOL: { perTx: "0.5" } } } });
    const tx = transferTx(keypair.publicKey, BigInt(lamports));
    if (ok) {
      await wallet.signTransaction(tx);
      assert.equal((await wallet.guard.spending())[0].used, "0.3");
    } else {
      await assert.rejects(wallet.signTransaction(tx), { code: "over_limit" });
      assert.ok(tx.signatures[0].every((b) => b === 0));
    }
  }
});

// A Solana provider whose sending is recorded (no network): for signAndSend, nativeTransfer and the refusals.
class FakeSvm extends SvmWalletProvider {
  #kp = web3.Keypair.generate();
  sent = []; ownTransfer = 0;
  trackInitialization() {}
  getAddress() { return this.#kp.publicKey.toBase58(); }
  getPublicKey() { return this.#kp.publicKey; }
  getNetwork() { return { protocolFamily: "svm", networkId: "solana-mainnet" }; }
  getName() { return "fake_svm"; }
  getConnection() { return { getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }) }; }
  async getBalance() { return 10n ** 9n; }
  async signTransaction(tx) { tx.sign([this.#kp]); return tx; }
  async sendTransaction(tx) { this.sent.push(tx); return "SIG"; }
  async signAndSendTransaction(tx) { return this.sendTransaction(await this.signTransaction(tx)); }
  async nativeTransfer() { this.ownTransfer++; return "UNGUARDED"; }
  async signMessage() { return new Uint8Array(64); }
  async getKeyPairSigner() { return "the raw key"; }
  async getSignatureStatus() { return null; }
  async waitForSignatureResult() { return { value: { err: null } }; }
}

test("Solana: signAndSendTransaction and nativeTransfer go through the guard; the raw key and messages are refused", async () => {
  const inner = new FakeSvm();
  const p = solPresign();
  const wallet = guardWalletProvider(inner, { pay: p.pay, verifyReceipts: "off" });
  assert.equal(await wallet.signAndSendTransaction(transferTx(inner.getPublicKey())), "SIG");
  assert.equal(inner.sent.length, 1);
  assert.ok(await verifies(inner.sent[0], inner.getPublicKey()));
  assert.equal(await wallet.nativeTransfer(OTHER.toBase58(), "1000"), "SIG");
  assert.equal(inner.ownTransfer, 0, "the provider's own transfer (signing inside itself) was not used");
  assert.equal(p.calls.length, 2);
  await assert.rejects(wallet.getKeyPairSigner(), { code: "unchecked" });
  await assert.rejects(wallet.signMessage(new Uint8Array([1])), { code: "unchecked" });
  const open = guardWalletProvider(new FakeSvm(), { pay: p.pay, verifyReceipts: "off", allowRawSign: true });
  assert.equal(await open.getKeyPairSigner(), "the raw key");

  // toSigner (what AgentKit's x402 actions pay with): the guarded signer, for @solana/kit transactions.
  const signer = await wallet.toSigner();
  assert.equal(signer.address, inner.getAddress());
  const [sigs] = await signer.signTransactions([{ messageBytes: transferTx(inner.getPublicKey()).message.serialize(), signatures: {} }]);
  assert.equal(sigs[inner.getAddress()].length, 64);
  assert.equal(p.calls.length, 3);
  wallet.guard.pause();
  await assert.rejects(wallet.signTransaction(transferTx(inner.getPublicKey())), { code: "paused" });
});

test("EVM signMessage is checked by presign-guard (type message) before the provider signs", async () => {
  const { inner, wallet, calls } = setup();
  assert.equal(await wallet.signMessage("hello"), "0xmsg");
  assert.deepEqual([calls[0].type, calls[0].method, calls[0].message], ["message", "personal_sign", "hello"]);
  assert.deepEqual(inner.signed.at(-1), ["signMessage", "hello"]);
  await wallet.signMessage(new Uint8Array([1, 2]));
  assert.equal(calls[1].message, "0x0102");
});
