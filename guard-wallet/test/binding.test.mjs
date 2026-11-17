// checkBinding: a presign-guard verdict counts only for the exact transaction it was signed for (presign-guard#291).
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson } from "x402-safe-fetch";
import { checkBinding, normaliseTx, txSha256, PRESIGN_BINDING_SIGNERS } from "../binding.js";
import { PRESIGN_SIGNERS } from "../index.js";

const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ERC20 = parseAbi(["function approve(address spender,uint256 amount)"]);
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
const tx = { chainId: 8453, from: "0x1111111111111111111111111111111111111111", to: USDC, value: "0", data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [ROUTER, 40_000_000n] }) };

async function answer(verdict, checked = tx, validUntil = Date.now() + 600_000) {
  const t = normaliseTx(checked);
  const body = { verdict, reasons: [] };
  const receipt = { request_id: "r1", route: "POST /v1/check", input_sha256: "x", binding: { scope: "evm-tx-v1", tx: t, tx_sha256: txSha256(t), valid_until: new Date(validUntil).toISOString() }, signed_at: new Date().toISOString(), signer: signer.address, algorithm: "eip191-canonical-json-v1" };
  return { ...body, receipt: { ...receipt, signature: await signer.signMessage({ message: canonicalJson({ ...body, receipt }) }) } };
}

test("checkBinding: MATCH (wallet fields ignored), CHANGED names the field, EXPIRED, UNTRUSTED", async () => {
  assert.deepEqual(PRESIGN_BINDING_SIGNERS, PRESIGN_SIGNERS, "the same pinned presign-guard signer");
  const signers = [signer.address];
  const a = await answer("green");
  const m = checkBinding({ ...tx, gas: "0x5208", nonce: 3, value: "0x0" }, a, { signers });
  assert.deepEqual([m.result, m.sign_ok], ["MATCH", true]);
  const bigger = checkBinding({ ...tx, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [ROUTER, 2n ** 256n - 1n] }) }, a, { signers });
  assert.deepEqual([bigger.result, bigger.changed], ["CHANGED", ["amount"]]);
  const spender = checkBinding({ ...tx, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: ["0x5555555555555555555555555555555555555555", 40_000_000n] }) }, a, { signers });
  assert.deepEqual(spender.changed, ["spender"]);
  assert.equal(checkBinding(tx, await answer("green", tx, Date.now() - 1), { signers }).result, "EXPIRED");
  assert.equal(checkBinding(tx, a).result, "UNTRUSTED", "a test key is not presign-guard's signer");
  const flipped = { ...(await answer("red")), verdict: "green" };
  assert.equal(checkBinding(tx, flipped, { signers }).result, "UNTRUSTED", "a red verdict flipped to green");
  const red = checkBinding(tx, await answer("red"), { signers });
  assert.deepEqual([red.result, red.sign_ok], ["MATCH", false], "red never signs");
});
