// An exam result on an agent's ERC-8004 record (src/exam/erc8004.js): the real server and a real attester account,
// with the chain stood in (Identity Registry reads, the Reputation Registry's giveFeedback).

process.env.X402_BENCH_NETWORK = "base-sepolia";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { keccak256, toBytes, encodeEventTopics, encodeAbiParameters } from "viem";

const { createExamServer } = await import("../src/exam/server.js");
const { memoryStore } = await import("../src/exam/store.js");
const { ABI, REPUTATION_REGISTRY, IDENTITY_REGISTRY, createAttester, publishMessage, TAG1 } = await import("../src/exam/erc8004.js");

const servers = [];
after(() => servers.forEach((s) => s.close()));
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// The chain, standing in: agents (owner, agent wallet) and the feedback given.
function chain(agents) {
  const given = [];
  const client = {
    async readContract({ address, functionName, args }) {
      assert.equal(address, IDENTITY_REGISTRY);
      const a = agents[String(args[0])];
      if (!a) throw new Error("ERC721NonexistentToken");
      return functionName === "ownerOf" ? a.owner : a.wallet ?? "0x0000000000000000000000000000000000000000";
    },
    async simulateContract(req) {
      assert.equal(req.address, REPUTATION_REGISTRY);
      assert.equal(req.functionName, "giveFeedback");
      if (agents[String(req.args[0])]?.revert) throw Object.assign(new Error("reverted"), { shortMessage: "Self-feedback not allowed" });
      return { request: req };
    },
    async waitForTransactionReceipt({ hash }) {
      const g = given.find((x) => x.tx === hash);
      const [agentId, value, decimals, tag1, tag2, endpoint, uri, fhash] = g.args;
      const topics = encodeEventTopics({ abi: ABI, eventName: "NewFeedback", args: { agentId, clientAddress: g.from, indexedTag1: tag1 } });
      const data = encodeAbiParameters([{ type: "uint64" }, { type: "int128" }, { type: "uint8" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "bytes32" }], [1n, value, decimals, tag1, tag2, endpoint, uri, fhash]);
      return { status: "success", logs: [{ address: REPUTATION_REGISTRY, topics, data, blockHash: "0x" + "11".repeat(32), blockNumber: 1n, logIndex: 0, transactionHash: hash, transactionIndex: 0, removed: false }] };
    },
  };
  const wallet = { async writeContract(req) { const tx = keccak256(toBytes(`tx${given.length}`)); given.push({ tx, args: req.args, from: req.account.address }); return tx; } };
  return { given, chains: () => client, wallets: () => wallet };
}

async function start({ attesterKey = generatePrivateKey(), agents = {} } = {}) {
  const holder = {};
  const http = (await import("node:http")).createServer((req, res) => holder.app(req, res));
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  servers.push(http);
  const origin = `http://127.0.0.1:${http.address().port}`;
  const c = chain(agents);
  const attester = attesterKey ? createAttester({ key: attesterKey, chains: c.chains, wallets: c.wallets, log: {} }) : { off: true };
  const exam = createExamServer({ origin, store: memoryStore(), signingKey: generatePrivateKey(), log: {}, twins: null, chains: c.chains, attester });
  servers.push({ close: exam.close });
  holder.app = exam.app;
  return { origin, ...c, attester };
}

// A finished exam of an operator (no answers: a low score, not admitted).
async function result(origin, op) {
  const m = await (await fetch(`${origin}/v1/exams/message?agent=onchain-agent&version=1&operator=${op.address}`)).json();
  const sheet = await (await post(`${origin}/v1/exams`, { agent: { name: "onchain-agent", version: "1" }, operator: op.address, signature: await op.signMessage({ message: m.message }) })).json();
  return (await post(`${origin}/v1/exams/${sheet.exam}/finish`, {})).json();
}
const sign = async (origin, op, r, agent, chainId = 8453) => {
  const m = await (await fetch(`${origin}/v1/results/${r.id}/erc8004/message?chain=${chainId}&agent=${agent}`)).json();
  return op.signMessage({ message: m.message });
};

test("the operator puts its result on its own ERC-8004 agent: feedback with the score, the file served byte for byte", async () => {
  const op = privateKeyToAccount(generatePrivateKey());
  const { origin, given, attester } = await start({ agents: { 42: { owner: op.address } } });
  const r = await result(origin, op);
  const m = await (await fetch(`${origin}/v1/results/${r.id}/erc8004/message?agent=42`)).json();
  assert.equal(m.message, publishMessage({ resultId: r.id, chainId: 8453, agentId: "42", operator: op.address, date: new Date().toISOString().slice(0, 10) }));
  assert.equal(m.attester, attester.address);
  const res = await post(`${origin}/v1/results/${r.id}/erc8004`, { chain: 8453, agent: "42", signature: await op.signMessage({ message: m.message }) });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(given.length, 1);
  const [agentId, value, decimals, tag1, tag2, endpoint, uri, fhash] = given[0].args;
  assert.deepEqual([agentId, value, decimals, tag1, tag2], [42n, BigInt(r.score), 0, TAG1, r.admitted ? "admitted" : "notAdmitted"]);
  assert.equal(endpoint, `${origin}/r/${r.id}`);
  assert.equal(uri, `${origin}/v1/results/${r.id}/erc8004/8453/42.json`);
  assert.equal(out.transaction, given[0].tx);
  assert.equal(out.feedback_index, 1);
  assert.equal(given[0].from, attester.address);
  // The file at feedbackURI hashes to feedbackHash, and carries the signed result.
  const bytes = await (await fetch(uri)).text();
  assert.equal(keccak256(toBytes(bytes)), fhash);
  const file = JSON.parse(bytes);
  assert.equal(file.agentRegistry, `eip155:8453:${IDENTITY_REGISTRY}`);
  assert.equal(file.agentId, 42);
  assert.equal(file.clientAddress, `eip155:8453:${attester.address}`);
  assert.equal(file.value, r.score);
  assert.equal(file.agentSafety.signature, r.signature);
  // Asked again: the same feedback, nothing sent twice.
  const again = await post(`${origin}/v1/results/${r.id}/erc8004`, { chain: 8453, agent: "42", signature: await sign(origin, op, r, 42) });
  assert.equal((await again.json()).transaction, given[0].tx);
  assert.equal(given.length, 1);
});

test("the agent wallet counts as the operator's too", async () => {
  const op = privateKeyToAccount(generatePrivateKey());
  const { origin, given } = await start({ agents: { 7: { owner: privateKeyToAccount(generatePrivateKey()).address, wallet: op.address } } });
  const r = await result(origin, op);
  assert.equal((await post(`${origin}/v1/results/${r.id}/erc8004`, { agent: "7", signature: await sign(origin, op, r, 7) })).status, 200);
  assert.equal(given.length, 1);
});

test("refused: someone else's agent, a signature of another wallet, an unknown agent or chain, no attester", async () => {
  const op = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const { origin, given } = await start({ agents: { 42: { owner: stranger.address } } });
  const r = await result(origin, op);
  const notMine = await post(`${origin}/v1/results/${r.id}/erc8004`, { agent: "42", signature: await sign(origin, op, r, 42) });
  assert.equal(notMine.status, 403);
  assert.match((await notMine.json()).error, /not the operator wallet's/);
  // The agent's owner can't put someone else's result on its agent either: only the result's operator signs.
  assert.equal((await post(`${origin}/v1/results/${r.id}/erc8004`, { agent: "42", signature: await sign(origin, stranger, r, 42) })).status, 401);
  assert.equal((await post(`${origin}/v1/results/${r.id}/erc8004`, { agent: "999", signature: await sign(origin, op, r, 999) })).status, 404);
  assert.equal((await post(`${origin}/v1/results/${r.id}/erc8004`, { chain: 1, agent: "42", signature: "0x" })).status, 400);
  assert.equal((await post(`${origin}/v1/results/${"0".repeat(24)}/erc8004`, { agent: "42", signature: "0x" })).status, 404);
  assert.equal(given.length, 0);
  const off = await start({ attesterKey: null, agents: { 1: { owner: op.address } } });
  const r2 = await result(off.origin, op);
  assert.equal((await post(`${off.origin}/v1/results/${r2.id}/erc8004`, { agent: "1", signature: await sign(off.origin, op, r2, 1) })).status, 503);
});

test("a feedback the registry refuses costs nothing and can be asked again", async () => {
  const op = privateKeyToAccount(generatePrivateKey());
  const agents = { 5: { owner: op.address, revert: true } };
  const { origin, given } = await start({ agents });
  const r = await result(origin, op);
  const res = await post(`${origin}/v1/results/${r.id}/erc8004`, { agent: "5", signature: await sign(origin, op, r, 5) });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Self-feedback not allowed/);
  assert.equal(given.length, 0);
  delete agents[5].revert;
  assert.equal((await post(`${origin}/v1/results/${r.id}/erc8004`, { agent: "5", signature: await sign(origin, op, r, 5) })).status, 200);
  assert.equal(given.length, 1);
  assert.equal((await fetch(`${origin}/v1/results/${r.id}/erc8004/8453/6.json`)).status, 404);
});

test("the attester key: off without one, off (with a warning) when malformed", () => {
  assert.equal(createAttester({ key: "" }).off, true);
  const warned = [];
  assert.equal(createAttester({ key: "abc", log: { warn: (m) => warned.push(m) } }).off, true);
  assert.equal(warned.length, 1);
  const k = generatePrivateKey();
  assert.equal(createAttester({ key: k.slice(2) }).address, privateKeyToAccount(k).address);
});
