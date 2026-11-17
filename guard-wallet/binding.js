// A presign-guard verdict bound to the exact transaction (presign-guard#291, 17 Nov 2026).
//
// The signed receipt of an EVM transaction check carries binding {scope "evm-tx-v1", tx {chainId, from, to, value,
// data}, tx_sha256, valid_until}, inside presign-guard's signature. Right before signing, checkBinding compares the
// transaction about to be signed with it, offline:
//   MATCH      same transaction, still valid, signed by presign-guard: sign only if the verdict is green (sign_ok)
//   CHANGED    a field changed since the check; `changed` names it (to, value, chainId, from, or from the decoded
//              call: spender, amount, recipient, amountOutMin, amountOutMinimum, path, deadline, operator, ...)
//   EXPIRED    older than valid_until: ask for a fresh verdict
//   UNTRUSTED  not signed by a presign-guard signer, changed after signing, or no binding in it
// The same rules as presign-guard's src/binding.js. Standard wallet fields (gas, nonce, fees) are ignored.
import { createHash } from "node:crypto";
import { decodeFunctionData, parseAbi } from "viem";
import { verifyReceipt, canonicalJson } from "x402-safe-fetch";

export const BINDING_SCOPE = "evm-tx-v1";
export const PRESIGN_BINDING_SIGNERS = ["0xf084Ea47Ca4D99BB4De3ECB0332b316bE6521EaE"];

const ABI = parseAbi([
  "function approve(address spender,uint256 amount)",
  "function increaseAllowance(address spender,uint256 addedValue)",
  "function transfer(address recipient,uint256 amount)",
  "function transferFrom(address owner,address recipient,uint256 amount)",
  "function setApprovalForAll(address operator,bool approved)",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address recipient,uint256 deadline)",
  "function swapTokensForExactTokens(uint256 amountOut,uint256 amountInMax,address[] path,address recipient,uint256 deadline)",
  "function swapExactETHForTokens(uint256 amountOutMin,address[] path,address recipient,uint256 deadline)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address recipient,uint256 deadline)",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address recipient,uint256 deadline)",
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)",
  "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params)",
  "function execute(bytes commands,bytes[] inputs,uint256 deadline)",
  "function execute(bytes commands,bytes[] inputs)",
]);
const HEX = /^0x[0-9a-fA-F]*$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function decimal(v) {
  if (v === undefined || v === null || v === "") return "0";
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === "bigint" && v >= 0n) return v.toString();
  if (typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v)) return v;
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v).toString();
  return null;
}

/** The fields a signer signs, normalised as presign-guard binds them; null when not a valid EVM transaction. */
export function normaliseTx(tx, chainId = tx?.chainId) {
  if (!tx || typeof tx !== "object") return null;
  const cid = typeof chainId === "string" && /^[0-9]+$/.test(chainId) ? Number(chainId) : typeof chainId === "string" && /^0x[0-9a-fA-F]+$/.test(chainId) ? Number(BigInt(chainId)) : chainId;
  const value = decimal(tx.value);
  const data = tx.data ?? tx.input ?? "0x";
  if (!Number.isSafeInteger(cid) || cid <= 0 || typeof tx.to !== "string" || !ADDR.test(tx.to) || value === null || typeof data !== "string" || !HEX.test(data)) return null;
  if (tx.from !== undefined && tx.from !== null && (typeof tx.from !== "string" || !ADDR.test(tx.from))) return null;
  return { chainId: cid, from: tx.from ? tx.from.toLowerCase() : null, to: tx.to.toLowerCase(), value, data: data.toLowerCase() };
}
export const txSha256 = (tx) => sha256(canonicalJson(tx));

const decode = (data) => { try { return decodeFunctionData({ abi: ABI, data }); } catch { return null; } };
function fields(call) {
  const out = {};
  const item = ABI.find((x) => x.type === "function" && x.name === call.functionName && x.inputs.length === call.args.length);
  (item?.inputs ?? []).forEach((input, i) => {
    const v = call.args[i];
    if (input.type === "tuple" && v && typeof v === "object") for (const c of input.components) out[c.name] = v[c.name];
    else out[input.name] = v;
  });
  const norm = (v) => (typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(norm).join(",") : typeof v === "string" ? v.toLowerCase() : String(v));
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, norm(v)]));
}
export function changedData(checked, actual) {
  if (checked === actual) return [];
  const a = decode(checked), b = decode(actual);
  if (!a || !b || a.functionName !== b.functionName) return ["data"];
  const fa = fields(a), fb = fields(b);
  const names = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter((k) => fa[k] !== fb[k]);
  return names.length ? names : ["data"];
}

/** Before signing: is this the transaction presign-guard checked, still valid, signed by presign-guard? */
export function checkBinding(tx, answer, { signers = PRESIGN_BINDING_SIGNERS, now = Date.now() } = {}) {
  const verdict = answer?.verdict ?? null;
  const base = { result: "UNTRUSTED", changed: [], verdict, valid_until: null, sign_ok: false };
  const sig = verifyReceipt(answer, { signers, service: "presign-guard" });
  if (!sig.valid) return { ...base, reason: sig.reason };
  const b = answer.receipt?.binding;
  if (!b || b.scope !== BINDING_SCOPE || !b.tx || typeof b.valid_until !== "string") return { ...base, reason: "no transaction binding in this answer" };
  if (txSha256(b.tx) !== b.tx_sha256) return { ...base, reason: "the binding's tx_sha256 does not match its tx" };
  const actual = normaliseTx(tx, tx?.chainId ?? b.tx.chainId);
  if (!actual) return { ...base, valid_until: b.valid_until, reason: "not a valid EVM transaction" };
  const changed = [];
  if (actual.chainId !== b.tx.chainId) changed.push("chainId");
  if (b.tx.from && actual.from && actual.from !== b.tx.from) changed.push("from");
  if (actual.to !== b.tx.to) changed.push("to");
  if (actual.value !== b.tx.value) changed.push("value");
  changed.push(...changedData(b.tx.data, actual.data));
  const expired = !(now < Date.parse(b.valid_until));
  const result = changed.length ? "CHANGED" : expired ? "EXPIRED" : "MATCH";
  return { result, changed, expired, verdict, valid_until: b.valid_until, sign_ok: result === "MATCH" && verdict === "green" };
}
