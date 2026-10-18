// Offline: approvals over AC2 against a fake AC2 service on a local socket. Nothing leaves this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, erc20Abi } from "viem";
import { ac2Approver, approvalText, algorandPublicKey, verifyApproval, defaultSocketPath } from "../ac2.js";
import { createLimiter } from "../limits.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SHOP = "0x1111111111111111111111111111111111111111";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// An Ed25519 key with its Algorand address (base32 of the key + the last 4 bytes of its SHA-512/256).
function algorandKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const bytes = Buffer.concat([raw, createHash("sha512-256").update(raw).digest().subarray(28)]);
  let bits = 0, value = 0, out = "";
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return { address: out, sign: (payload) => sign(null, Buffer.from(payload), privateKey).toString("base64") };
}

// A fake AC2 service: answers agent.hello, daemon.status and agent.request the way ac2-cli does. wallet: when the
// wallet is connected ("always", "afterHello" = once an agent registered and after two more status polls, "never").
async function fakeService({ walletAddress = null, wallet = "always", answer }) {
  const dir = mkdtempSync(join(tmpdir(), "ac2-"));
  const path = join(dir, "ac2d.sock");
  const requests = [];
  let hello = false, polls = 0;
  const state = () => wallet === "always" || (wallet === "afterHello" && hello && ++polls > 2) ? "connected" : "reconnecting";
  const server = createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", async (chunk) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const frame = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        requests.push(frame);
        sock.write(`${JSON.stringify({ event: "connection.presence", data: { present: true } })}\n`); // events are skipped
        if (frame.method === "agent.hello") { hello = true; sock.write(`${JSON.stringify({ id: frame.id, result: { protocolVersion: 1 } })}\n`); continue; }
        if (frame.method === "daemon.status") {
          sock.write(`${JSON.stringify({ id: frame.id, result: { protocolVersion: 1, connection: { state: state(), walletAddress, locked: false } } })}\n`);
          continue;
        }
        const reply = await answer(frame.params);
        if (reply === "hang") continue;
        sock.write(`${JSON.stringify({ id: frame.id, ...reply })}\n`);
      }
    });
  });
  await new Promise((ok) => server.listen(path, ok));
  return { path, requests, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const approve = (key) => async (params) => ({ result: { status: "response", message: { type: "ac2/SigningResponse", from: "did:key:zWallet", to: ["did:key:zAgent"], body: { signature: key.sign(Buffer.from(params.body.payload, "base64")), public_key: "irrelevant" } } } });

const info = {
  method: "sendTransaction",
  request: { type: "transaction", chainId: 8453, to: USDC_BASE },
  verdict: { verdict: "green", reasons: [] },
  reasons: [{ code: "per_tx" }],
  summary: "8 USDC is over the limit of 5 per transaction",
  spending: [{ token: "USDC", used: "0", perDay: null }],
  purchase: { url: "https://api.example.com/report", description: "Daily report" },
};

test("Algorand addresses: the key and checksum are read; a typo is refused", () => {
  const key = algorandKey();
  assert.equal(algorandPublicKey(key.address).length, 32);
  const typo = key.address.slice(0, 10) + (key.address[10] === "A" ? "B" : "A") + key.address.slice(11);
  assert.equal(algorandPublicKey(typo), null);
  assert.equal(algorandPublicKey("not an address"), null);
  assert.throws(() => ac2Approver({ owner: typo }), /Algorand address/);
});

test("the text to sign starts with the prefix and names what is approved", () => {
  const text = approvalText(info, { label: "research-bot", id: "abc123", expiresAt: Date.UTC(2026, 9, 18, 12, 0) });
  assert.ok(text.startsWith("fizzl-approval-v1\nresearch-bot wants to sign something over your limit\n8 USDC is over the limit"));
  assert.match(text, /for: Daily report\nurl: https:\/\/api\.example\.com\/report/);
  assert.match(text, /presign-guard: green/);
  assert.match(text, /id: abc123\nexpires: 2026-10-18T12:00:00\.000Z$/);
});

test("approved in the wallet: the owner's signature is checked and comes back as proof", async () => {
  const owner = algorandKey();
  const svc = await fakeService({ answer: approve(owner) });
  try {
    const answer = await ac2Approver({ owner: owner.address, socket: svc.path, label: "research-bot" })(info);
    assert.equal(answer.approved, true);
    assert.equal(answer.proof.via, "ac2");
    assert.equal(answer.proof.owner, owner.address);
    assert.ok(verifyApproval(owner.address, answer.proof.payload, answer.proof.signature));
    const req = svc.requests.find((r) => r.method === "agent.request").params;
    assert.equal(req.type, "ac2/SigningRequest");
    assert.deepEqual(req.responseTypes, ["ac2/SigningResponse", "ac2/SigningRejected"]);
    assert.deepEqual([req.body.encoding, req.body.sig_hint, req.body.key_type, req.body.display_hint, req.body.schema], ["base64", "raw-ed25519", "account", "text", "fizzl/over-limit-approval/v1"]);
    assert.match(req.body.description, /^research-bot: over your limit for api\.example\.com\. 8 USDC/);
    assert.equal(Buffer.from(req.body.payload, "base64").toString(), answer.proof.payload);
  } finally { svc.close(); }
});

test("declined, signed by another key, or out of time: no", async () => {
  const owner = algorandKey();
  const stranger = algorandKey();
  for (const answer of [
    async () => ({ result: { status: "response", message: { type: "ac2/SigningRejected", from: "w", to: ["a"], body: { reason: "user declined" } } } }),
    approve(stranger),
    async () => ({ result: { status: "response", message: { type: "ac2/SigningResponse", from: "w", to: ["a"], body: { signature: "AAAA", public_key: "x" } } } }),
    async () => ({ error: { code: "internal", message: "timed out waiting for the wallet" } }),
  ]) {
    const svc = await fakeService({ answer });
    try {
      assert.equal(await ac2Approver({ owner: owner.address, socket: svc.path })(info), false);
    } finally { svc.close(); }
  }
  const svc = await fakeService({ answer: async () => "hang" });
  try {
    assert.equal(await ac2Approver({ owner: owner.address, socket: svc.path, timeoutMs: 50 })(info), false, "the service never answers");
  } finally { svc.close(); }
});

test("no service, no wallet coming back, or a locked session: an error, so nothing is signed", async () => {
  const owner = algorandKey();
  await assert.rejects(ac2Approver({ owner: owner.address, socket: join(tmpdir(), "no-such-ac2.sock") })(info), /can't reach the AC2 service.*ac2 pair/);
  const gone = await fakeService({ wallet: "never", answer: approve(owner) });
  try {
    await assert.rejects(ac2Approver({ owner: owner.address, socket: gone.path, connectTimeoutMs: 30, pollMs: 5 })(info), /not connected to the AC2 service \(reconnecting\): open AC2 Wallet/);
    assert.equal(gone.requests.filter((r) => r.method === "agent.request").length, 0, "nothing was asked");
  } finally { gone.close(); }
  let svc = await fakeService({ answer: async () => ({ error: { code: "not_connected", message: "no connected wallet to send an AC2 request to" } }) });
  try { await assert.rejects(ac2Approver({ owner: owner.address, socket: svc.path })(info), /no connected wallet/); } finally { svc.close(); }
  svc = await fakeService({ answer: async () => ({ result: { status: "unavailable", reason: "locked" } }) });
  try { await assert.rejects(ac2Approver({ owner: owner.address, socket: svc.path })(info), /can't ask your wallet \(locked\)/); } finally { svc.close(); }
  svc = await fakeService({ answer: approve(owner) }); // no owner given, and the service reports no address
  try { await assert.rejects(ac2Approver({ socket: svc.path })(info), /set owner/); } finally { svc.close(); }
});

test("without owner: the paired wallet's address is used, and fixed after the first request", async () => {
  const owner = algorandKey();
  const svc = await fakeService({ walletAddress: owner.address, answer: approve(owner) });
  try {
    const onOverLimit = ac2Approver({ socket: svc.path });
    assert.equal((await onOverLimit(info)).proof.owner, owner.address);
    await onOverLimit(info);
    assert.equal(svc.requests.filter((r) => r.method === "agent.request").length, 2);
  } finally { svc.close(); }
});

test("after a restart: registers as an agent, waits for the wallet to come back, then asks", async () => {
  const owner = algorandKey();
  const svc = await fakeService({ wallet: "afterHello", answer: approve(owner) });
  try {
    const answer = await ac2Approver({ owner: owner.address, socket: svc.path, pollMs: 5 })(info);
    assert.equal(answer.approved, true);
    const methods = svc.requests.map((r) => r.method);
    assert.equal(methods[0], "agent.hello");
    assert.match(svc.requests[0].params.agent, /^presign-guard-wallet-\d+$/);
    assert.ok(methods.filter((m) => m === "daemon.status").length >= 3, "polled until connected");
    assert.equal(methods.at(-1), "agent.request");
  } finally { svc.close(); }
});

test("with the spending limits: an approved spend carries the signed approval to onSpend", async () => {
  const owner = algorandKey();
  const svc = await fakeService({ answer: approve(owner) });
  const spent = [];
  try {
    const limiter = createLimiter({ tokens: { USDC: { perTx: "5" } } }, { onOverLimit: ac2Approver({ owner: owner.address, socket: svc.path }), onSpend: (e) => spent.push(e) });
    const request = { type: "transaction", chainId: 8453, value: "0", to: USDC_BASE, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [SHOP, 8_000_000n] }) };
    const booked = await limiter.reserve({ method: "sendTransaction", request, verdict: { verdict: "green", reasons: [] }, purchase: info.purchase });
    assert.equal(booked.ok, true);
    limiter.spent(booked.entries, "0xhash", { verdict: null, purchase: info.purchase, approval: booked.approval });
    assert.equal(spent.length, 1);
    assert.equal(spent[0].approval.owner, owner.address);
    assert.ok(verifyApproval(owner.address, spent[0].approval.payload, spent[0].approval.signature));
  } finally { svc.close(); }
});

test("the socket path follows ac2-cli: AC2_DAEMON_SOCKET, then AC2_HOME, then ~/.ac2", () => {
  assert.equal(defaultSocketPath({ AC2_DAEMON_SOCKET: "/tmp/x.sock" }, "linux"), "/tmp/x.sock");
  assert.equal(defaultSocketPath({ AC2_HOME: "/srv/ac2" }, "linux"), "/srv/ac2/ac2d.sock");
  assert.match(defaultSocketPath({}, "linux"), /\.ac2\/ac2d\.sock$/);
  assert.equal(defaultSocketPath({}, "win32"), "\\\\.\\pipe\\ac2-daemon");
});
