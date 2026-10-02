// Offline: Telegram approvals against a fake Bot API. Nothing is sent to Telegram.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeFunctionData, erc20Abi } from "viem";
import { canonicalJson, inputHash } from "x402-safe-fetch";
import { guardWallet } from "../index.js";
import { telegramApprover, findTelegramChats } from "../telegram.js";

const OWNER = 4242;
const STRANGER = 777;
let tokenSeq = 0;
const newToken = () => `${100000 + tokenSeq++}:AAH${"x".repeat(30)}`; // a fresh bot per test: pollers are per token

// A fake Bot API: records calls, hands out queued updates to getUpdates (long poll, abortable).
function fakeTelegram({ fail } = {}) {
  const calls = [];
  const queue = [];
  let updateId = 1;
  let messageId = 10;
  const waiting = new Set();
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    if (fail?.[method]) return Response.json({ ok: false, error_code: fail[method].code, description: fail[method].text }, { status: fail[method].code });
    if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: messageId++, chat: { id: body.chat_id } } });
    if (method === "getUpdates") {
      const pending = () => queue.filter((u) => body.offset === undefined || u.update_id >= body.offset);
      if (!pending().length) {
        await new Promise((ok, no) => {
          const t = setTimeout(ok, 40);
          const w = () => { clearTimeout(t); ok(); };
          waiting.add(w);
          init.signal?.addEventListener("abort", () => { clearTimeout(t); waiting.delete(w); no(Object.assign(new Error("aborted"), { name: "AbortError" })); });
        });
      }
      return Response.json({ ok: true, result: pending() });
    }
    return Response.json({ ok: true, result: true });
  };
  const sent = () => calls.filter((c) => c.method === "sendMessage");
  return {
    calls, fetchImpl, sent,
    // Tap a button on the n-th sent message.
    tap(n, which, fromId = OWNER, chatId = OWNER) {
      const kb = sent()[n].body.reply_markup.inline_keyboard[0];
      const data = (which === "approve" ? kb[0] : kb[1]).callback_data;
      queue.push({ update_id: updateId++, callback_query: { id: `cb${updateId}`, data, from: { id: fromId, username: fromId === OWNER ? "frits" : "someone" }, message: { message_id: 10 + n, chat: { id: chatId } } } });
      for (const w of waiting) w();
    },
    message(chat) { queue.push({ update_id: updateId++, message: { chat, text: "/start" } }); },
  };
}

const until = async (cond, ms = 2000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((ok) => setTimeout(ok, 5)); } };
const INFO = { method: "sendTransaction", request: { type: "transaction", chainId: 8453, to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, verdict: { verdict: "green", reasons: [] }, reasons: [{ code: "per_tx" }], summary: "8 USDC is over the limit of 5 per transaction <b>", spending: [{ token: "USDC", used: "3", perDay: "20" }] };

test("approve: the message says what and why, the tap signs, the message is updated", async () => {
  const tg = fakeTelegram();
  const ask = telegramApprover({ token: newToken(), chatId: OWNER, label: "research-agent", fetch: tg.fetchImpl });
  const answer = ask(INFO);
  await until(() => tg.sent().length === 1);
  const text = tg.sent()[0].body.text;
  assert.match(text, /research-agent wants to sign/);
  assert.match(text, /8 USDC is over the limit of 5 per transaction &lt;b&gt;/); // escaped
  assert.match(text, /presign-guard: <b>green<\/b>/);
  assert.match(text, /USDC 3 \/ 20/);
  tg.tap(0, "approve");
  assert.equal(await answer, true);
  await until(() => tg.calls.some((c) => c.method === "editMessageText"));
  assert.match(tg.calls.find((c) => c.method === "editMessageText").body.text, /Approved by @frits: signing/);
});

test("deny: returns false", async () => {
  const tg = fakeTelegram();
  const answer = telegramApprover({ token: newToken(), chatId: OWNER, fetch: tg.fetchImpl })(INFO);
  await until(() => tg.sent().length === 1);
  tg.tap(0, "deny");
  assert.equal(await answer, false);
});

test("only allowed people can answer; a stranger's tap is refused", async () => {
  const tg = fakeTelegram();
  const answer = telegramApprover({ token: newToken(), chatId: OWNER, fetch: tg.fetchImpl })(INFO);
  await until(() => tg.sent().length === 1);
  tg.tap(0, "approve", STRANGER, OWNER);
  await until(() => tg.calls.some((c) => c.method === "answerCallbackQuery" && /not allowed/.test(c.body.text)));
  tg.tap(0, "deny");
  assert.equal(await answer, false);
});

test("no answer in time: denied, and the message says so", async () => {
  const tg = fakeTelegram();
  assert.equal(await telegramApprover({ token: newToken(), chatId: OWNER, timeoutMs: 60, fetch: tg.fetchImpl })(INFO), false);
  await until(() => tg.calls.some((c) => c.method === "editMessageText"));
  assert.match(tg.calls.find((c) => c.method === "editMessageText").body.text, /No answer in 1 min: not signed/);
});

test("two requests at once share one bot and each gets its own answer", async () => {
  const tg = fakeTelegram();
  const ask = telegramApprover({ token: newToken(), chatId: OWNER, fetch: tg.fetchImpl });
  const a = ask(INFO), b = ask({ ...INFO, summary: "second" });
  await until(() => tg.sent().length === 2);
  tg.tap(1, "approve");
  tg.tap(0, "deny");
  assert.deepEqual(await Promise.all([a, b]), [false, true]);
});

test("a webhook or a second poller (409) fails the request instead of hanging", async () => {
  const tg = fakeTelegram({ fail: { getUpdates: { code: 409, text: "Conflict: terminated by other getUpdates request" } } });
  await assert.rejects(telegramApprover({ token: newToken(), chatId: OWNER, fetch: tg.fetchImpl })(INFO), /Conflict/);
});

const presignKey = privateKeyToAccount(generatePrivateKey());
async function signedVerdict(input) {
  const route = "POST /v1/check";
  const body = { version: "2", verdict: "green", reasons: [] };
  const receipt = { request_id: "p1", route, input_sha256: inputHash(route, input), signed_at: "2026-10-02T10:00:00.000Z", signer: presignKey.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await presignKey.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}

test("with guardWallet: over the limit → Telegram → approved → signed; a Telegram failure stops the wallet", async () => {
  const signedTx = [];
  const wallet = { chain: { id: 8453 }, account: { address: "0x2222222222222222222222222222222222222222" }, sendTransaction: async (a) => { signedTx.push(a); return "0xtx"; } };
  const pay = async (_u, init) => Response.json(await signedVerdict(JSON.parse(init.body)));
  const tx = { to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: ["0x1111111111111111111111111111111111111111", 8_000_000n] }) };

  const tg = fakeTelegram();
  const guarded = guardWallet(wallet, { pay, signers: [presignKey.address], limits: { tokens: { USDC: { perTx: "5" } } }, onOverLimit: telegramApprover({ token: newToken(), chatId: OWNER, fetch: tg.fetchImpl }) });
  const sending = guarded.sendTransaction(tx);
  await until(() => tg.sent().length === 1);
  assert.match(tg.sent()[0].body.text, /8 USDC is over the limit of 5 per transaction/);
  tg.tap(0, "approve");
  assert.equal(await sending, "0xtx");
  assert.equal(signedTx.length, 1);

  const broken = fakeTelegram({ fail: { sendMessage: { code: 403, text: "Forbidden: bot was blocked by the user" } } });
  const g2 = guardWallet(wallet, { pay, signers: [presignKey.address], limits: { tokens: { USDC: { perTx: "5" } } }, onOverLimit: telegramApprover({ token: newToken(), chatId: OWNER, fetch: broken.fetchImpl }) });
  await assert.rejects(g2.sendTransaction(tx), { code: "limit_unavailable" });
  assert.equal(signedTx.length, 1);
});

test("findTelegramChats lists who wrote to the bot; bad settings are caught early", async () => {
  const tg = fakeTelegram();
  tg.message({ id: OWNER, type: "private", first_name: "Frits", username: "frits" });
  assert.deepEqual(await findTelegramChats({ token: newToken(), fetch: tg.fetchImpl }), [{ chatId: OWNER, type: "private", name: "Frits", username: "frits" }]);
  assert.throws(() => telegramApprover({ token: "nope", chatId: 1 }), /bot token/);
  assert.throws(() => telegramApprover({ token: newToken() }), /chatId is required/);
});
