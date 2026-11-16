// wdkEvmSigner (wdk.js): a Tether WDK EVM account pays through createSafeFetch. Offline: the WDK account is a stand-in
// that behaves like @tetherto/wdk-wallet-evm's WalletAccountEvm (async getAddress, signTypedData({ domain, types,
// message }) signed with the one top-level type, EIP712Domain in types refused, as ethers does). On 16 Nov 2026 the real
// WalletAccountEvm (1.0.0-beta.26) gave viem's exact signature for the same key and TransferWithAuthorization.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { createSafeFetch } from "../index.js";
import { wdkEvmSigner, rootTypes } from "../wdk.js";

const URL_ = "https://seller.example/data";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";

function fakeWdkAccount(key = generatePrivateKey()) {
  const inner = privateKeyToAccount(key);
  const calls = [];
  return {
    calls,
    async getAddress() { return inner.address; },
    async signTypedData({ domain, types, message }) {
      calls.push({ domain, types, message });
      if ("EIP712Domain" in types) throw new Error('ambiguous primary types or unused types: "EIP712Domain"');
      const roots = rootTypes(types);
      if (roots.length !== 1) throw new Error("ambiguous primary types");
      return inner.signTypedData({ domain, types, primaryType: roots[0], message });
    },
  };
}

function seller() {
  const log = { paid: [] };
  const offer = { scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const fetch = async (input, init = {}) => {
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    const sig = headers.get("payment-signature") ?? headers.get("x-payment");
    if (!sig) {
      const challenge = { x402Version: 2, error: "payment required", resource: { url: URL_, description: "data", mimeType: "application/json" }, accepts: [offer] };
      return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") } });
    }
    log.paid.push(JSON.parse(Buffer.from(sig, "base64").toString()));
    return Response.json({ ok: true });
  };
  return { log, fetch };
}

test("a WDK account pays through createSafeFetch: the authorization is signed by the WDK account and recovers to its address", async () => {
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const wdk = fakeWdkAccount();
  const signer = await wdkEvmSigner(wdk);
  const s = seller();
  const safeFetch = createSafeFetch({ maxUsd: 0.05, trusted: ["seller.example"], fetch: s.fetch, register: (c) => c.register("eip155:8453", new ExactEvmScheme(signer)) });
  const res = await safeFetch(URL_);
  assert.equal(res.status, 200);
  assert.equal(s.log.paid.length, 1);
  assert.equal(wdk.calls.length, 1, "the WDK account signed once");
  const { authorization, signature } = s.log.paid[0].payload;
  assert.equal(authorization.from.toLowerCase(), signer.address.toLowerCase());
  assert.equal(authorization.to.toLowerCase(), PAY_TO);
  const domain = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC };
  const types = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
  const message = { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) };
  const who = await recoverTypedDataAddress({ domain, types, primaryType: "TransferWithAuthorization", message, signature });
  assert.equal(who.toLowerCase(), signer.address.toLowerCase());
});

test("over budget: the WDK account is never asked to sign", async () => {
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const wdk = fakeWdkAccount();
  const s = seller();
  const safeFetch = createSafeFetch({ maxUsd: 0.01, trusted: ["seller.example"], fetch: s.fetch, register: async (c) => c.register("eip155:8453", new ExactEvmScheme(await wdkEvmSigner(wdk))) });
  await assert.rejects(safeFetch(URL_));
  assert.equal(wdk.calls.length, 0);
  assert.equal(s.log.paid.length, 0);
});

test("EIP712Domain in types is dropped before WDK signs (ethers refuses it)", async () => {
  const wdk = fakeWdkAccount();
  const signer = await wdkEvmSigner(wdk);
  const sig = await signer.signTypedData({
    domain: { name: "X", version: "1", chainId: 8453 },
    types: { EIP712Domain: [{ name: "name", type: "string" }], Mail: [{ name: "contents", type: "string" }] },
    primaryType: "Mail",
    message: { contents: "hi" },
  });
  assert.match(sig, /^0x[0-9a-f]+$/i);
  assert.ok(!("EIP712Domain" in wdk.calls[0].types));
});

test("refused when WDK would sign another type than the requested primaryType", async () => {
  const wdk = fakeWdkAccount();
  const signer = await wdkEvmSigner(wdk);
  const types = { Outer: [{ name: "inner", type: "Inner" }], Inner: [{ name: "x", type: "uint256" }] };
  await assert.rejects(signer.signTypedData({ domain: {}, types, primaryType: "Inner", message: { x: 1n } }), /refusing to sign/);
  await assert.rejects(signer.signTypedData({ domain: {}, types: { A: [{ name: "a", type: "uint256" }], B: [{ name: "b", type: "uint256" }] }, primaryType: "A", message: { a: 1n } }), /refusing to sign/);
  assert.equal(wdk.calls.length, 0);
  assert.deepEqual(rootTypes({ P: [{ name: "items", type: "Item[]" }], Item: [{ name: "v", type: "uint256" }] }), ["P"]);
});

test("not a WDK account, or no EVM address: a clear error", async () => {
  await assert.rejects(wdkEvmSigner({}), /Tether WDK EVM account/);
  await assert.rejects(wdkEvmSigner({ getAddress: async () => "not-an-address", signTypedData: async () => "0x" }), /no EVM address/);
});
