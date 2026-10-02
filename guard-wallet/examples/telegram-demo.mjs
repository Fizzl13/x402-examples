// Telegram approval demo: a pretend agent tries to send 8 USDC with a 5 USDC
// per-transaction limit. You get the request on Telegram and tap Approve or
// Deny. Nothing real happens: the wallet is a stub that never broadcasts, and
// the presign-guard verdict is signed locally (no payment, no network call to
// presign-guard). Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeFunctionData, erc20Abi } from "viem";
import { canonicalJson, inputHash } from "x402-safe-fetch";
import { guardWallet, PresignBlockedError } from "../index.js";
import { telegramApprover } from "../telegram.js";

const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = process.env;
if (!token || !chatId) { console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID."); process.exit(1); }

// A local stand-in for presign-guard: a green verdict, signed by a throwaway key.
const demoSigner = privateKeyToAccount(generatePrivateKey());
const pay = async (_url, init) => {
  const input = JSON.parse(init.body);
  const route = "POST /v1/check";
  const body = { version: "2", verdict: "green", reasons: [{ code: "DEMO", severity: "info" }] };
  const receipt = { request_id: "demo", route, input_sha256: inputHash(route, input), signed_at: new Date().toISOString(), signer: demoSigner.address, algorithm: "eip191-canonical-json-v1" };
  return Response.json({ ...body, receipt: { ...receipt, signature: await demoSigner.signMessage({ message: canonicalJson({ ...body, receipt }) }) } });
};

// A wallet that only pretends to send.
const stub = { chain: { id: 8453 }, account: privateKeyToAccount(generatePrivateKey()), sendTransaction: async () => "0xdemo-not-broadcast" };

const wallet = guardWallet(stub, {
  pay,
  signers: [demoSigner.address],
  limits: { tokens: { USDC: { perTx: "5", perDay: "20" } } },
  onOverLimit: telegramApprover({ token, chatId, label: "demo-agent (GitHub Actions test)", timeoutMs: 5 * 60_000 }),
  onSpend: (e) => console.log(`booked: ${e.amount} ${e.budget}`),
});

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const tx = { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: ["0x1111111111111111111111111111111111111111", 8_000_000n] }) };

console.log("demo-agent wants to send 8 USDC (limit 5 per transaction). Check Telegram and tap Approve or Deny (5 minutes)…");
try {
  const hash = await wallet.sendTransaction(tx);
  console.log(`RESULT approved: the wallet signed (${hash}). Spending now:`, JSON.stringify(await wallet.spending()));
} catch (err) {
  if (err instanceof PresignBlockedError) console.log(`RESULT not signed: ${err.code} · ${err.message}`);
  else { console.error("RESULT error:", err.message); process.exit(1); }
}
process.exit(0);
