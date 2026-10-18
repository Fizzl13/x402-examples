// Approve over-limit signatures in your own wallet app, over AC2 (the Algorand Foundation's Agentic
// Communication and Control protocol, github.com/algorandfoundation/ac2).
//
//   import { ac2Approver } from "presign-guard-wallet/ac2";
//   guardWallet(walletClient, { pay, limits, onOverLimit: ac2Approver({ owner: "YOUR…ALGORAND…ADDRESS" }) });
//
// When a signature would cross a limit, your AC2 wallet (AC2 Wallet on your phone) shows what the agent wants
// to sign, why it is over the limit and presign-guard's verdict. You approve with your passkey, and the wallet
// signs that approval with your Algorand account key. A decline, no answer in time (default 10 minutes) or a
// signature that isn't from the owner's account counts as Deny. The signed approval goes along with the spend
// (onSpend's approval), as proof of who approved what.
//
// What is signed is a text that starts with "fizzl-approval-v1", never a transaction: Algorand signs
// transactions over "TX" + the transaction, so a signed approval can't be used as a payment.
//
// Needs the AC2 service (ac2-cli) running on this machine and paired with your wallet (`ac2 pair`). This module
// talks to it over its local socket (~/.ac2/ac2d.sock, or AC2_DAEMON_SOCKET) and needs no extra packages. If the
// service isn't running or no wallet is paired, the wallet stops (limit_unavailable) rather than signing.

import { connect as netConnect } from "node:net";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const PREFIX = "fizzl-approval-v1";
const SCHEMA = "fizzl/over-limit-approval/v1";
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// The AC2 service's control socket, as ac2-cli resolves it.
export function defaultSocketPath(env = process.env, platform = process.platform) {
  const override = env.AC2_DAEMON_SOCKET?.trim();
  if (override) return override;
  if (platform === "win32") {
    const home = env.AC2_HOME?.trim();
    return home ? `\\\\.\\pipe\\ac2-daemon-${createHash("sha256").update(home).digest("hex").slice(0, 12)}` : "\\\\.\\pipe\\ac2-daemon";
  }
  return join(env.AC2_HOME?.trim() || join(homedir(), ".ac2"), "ac2d.sock");
}

// The 32-byte Ed25519 public key in an Algorand address (base32 of key + 4-byte checksum), or null.
export function algorandPublicKey(address) {
  if (typeof address !== "string" || !/^[A-Z2-7]{58}$/.test(address)) return null;
  let bits = 0, value = 0;
  const out = [];
  for (const c of address) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const bytes = Buffer.from(out.slice(0, 36));
  const key = bytes.subarray(0, 32);
  const sum = createHash("sha512-256").update(key).digest().subarray(28);
  return sum.equals(bytes.subarray(32, 36)) ? key : null;
}

// True when signature (base64) is the owner's Ed25519 signature over payload.
export function verifyApproval(owner, payload, signature) {
  const key = algorandPublicKey(owner);
  const sig = typeof signature === "string" ? Buffer.from(signature, "base64") : null;
  if (!key || !sig || sig.length !== 64) return false;
  try {
    return verify(null, Buffer.from(payload), createPublicKey({ key: Buffer.concat([SPKI_ED25519, key]), format: "der", type: "spki" }), sig);
  } catch {
    return false;
  }
}

// One request to the AC2 service: newline-delimited JSON, answered on the same connection.
function controlRequest(path, method, params, { timeoutMs, connect }) {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    let buf = "";
    const done = (fn, arg) => { clearTimeout(timer); sock.destroy(); fn(arg); };
    const timer = setTimeout(() => done(reject, Object.assign(new Error(`the AC2 service did not answer ${method} in time`), { code: "timeout" })), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("error", (err) => done(reject, Object.assign(new Error(`can't reach the AC2 service at ${path} (${err.code ?? err.message}): start it and pair your wallet with \`ac2 pair\``), { code: "unreachable" })));
    sock.on("connect", () => sock.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    sock.on("data", (chunk) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.id !== 1) continue; // events and other replies
        if (frame.error) return done(reject, Object.assign(new Error(`AC2 service: ${frame.error.message ?? frame.error.code}`), { code: frame.error.code }));
        return done(resolve, frame.result);
      }
    });
  });
}

// The text the owner signs: everything they approve, starting with the prefix, ending with id and expiry.
export function approvalText(info, { label, id, expiresAt }) {
  const r = info.request ?? {};
  const lines = [PREFIX, `${label} wants to sign something over your limit`, String(info.summary ?? "")];
  if (info.purchase?.description) lines.push(`for: ${info.purchase.description}`);
  if (info.purchase?.url) lines.push(`url: ${info.purchase.url}`);
  lines.push(`${info.method} · chain ${r.chainId ?? "?"}${r.to ? ` · to ${r.to}` : ""}`);
  const v = info.verdict?.verdict;
  const codes = (info.verdict?.reasons ?? []).filter((x) => x.severity !== "info").map((x) => x.code).join(", ");
  lines.push(v ? `presign-guard: ${v}${codes ? ` (${codes})` : ""}` : "presign-guard: no verdict for this one");
  const spent = (info.spending ?? []).map((s) => `${s.token} ${s.used}${s.perDay ? ` / ${s.perDay}` : ""}`).join(" · ");
  if (spent) lines.push(`spent this window: ${spent}`);
  lines.push(`id: ${id}`, `expires: ${new Date(expiresAt).toISOString()}`);
  return lines.join("\n");
}

/**
 * An onOverLimit for guardWallet that asks you in your AC2 wallet, and checks your signature.
 * @param {object} [o]
 * @param {string} [o.owner]  your Algorand address; only its signature approves. Default: the wallet the AC2 service is paired with, fixed at the first request.
 * @param {string} [o.socket]  the AC2 service's socket (default ~/.ac2/ac2d.sock or AC2_DAEMON_SOCKET)
 * @param {number} [o.timeoutMs]  how long the agent waits for you (default 10 minutes); no answer = deny
 * @param {string} [o.label]  name of the agent in the request (default "Your agent")
 */
export function ac2Approver({ owner, socket = defaultSocketPath(), timeoutMs = 600_000, label = "Your agent", connect = netConnect, now = () => Date.now() } = {}) {
  if (owner !== undefined && !algorandPublicKey(owner)) throw new TypeError("owner must be an Algorand address (58 characters, with a valid checksum)");
  if (!(timeoutMs > 0)) throw new TypeError("timeoutMs must be a positive number of milliseconds");
  let pinned = owner ?? null;
  const ask = (method, params, ms = 10_000) => controlRequest(socket, method, params, { timeoutMs: ms, connect });

  return async function onOverLimit(info) {
    if (!pinned) {
      const status = await ask("daemon.status", {});
      const address = status?.connection?.walletAddress;
      if (status?.connection?.state !== "connected" || !algorandPublicKey(address)) throw Object.assign(new Error("no wallet is paired with the AC2 service: run `ac2 pair` and scan the code with your wallet"), { code: "not_connected" });
      pinned = address;
    }
    const id = randomBytes(8).toString("hex");
    const expiresAt = now() + timeoutMs;
    const text = approvalText(info, { label, id, expiresAt });
    const where = info.purchase?.url ? (() => { try { return ` for ${new URL(info.purchase.url).host}`; } catch { return ""; } })() : "";
    let result;
    try {
      result = await ask("agent.request", {
        type: "ac2/SigningRequest",
        body: {
          description: `${label}: over your limit${where}. ${info.summary ?? ""}`.slice(0, 300),
          encoding: "base64",
          payload: Buffer.from(text).toString("base64"),
          schema: SCHEMA,
          display_hint: "text",
          sig_hint: "raw-ed25519",
          key_type: "account",
        },
        responseTypes: ["ac2/SigningResponse", "ac2/SigningRejected"],
        expires_in_seconds: Math.ceil(timeoutMs / 1000),
        timeoutMs,
      }, timeoutMs + 15_000);
    } catch (err) {
      if (err.code === "timeout" || /timed? ?out/i.test(err.message)) return false; // no answer in time
      throw err;
    }
    if (result?.status === "unavailable") throw Object.assign(new Error(`the AC2 service can't ask your wallet (${result.reason})`), { code: result.reason });
    const msg = result?.message;
    if (result?.status !== "response" || msg?.type !== "ac2/SigningResponse") return false; // declined
    if (now() > expiresAt) return false;
    if (!verifyApproval(pinned, text, msg.body?.signature)) {
      console.warn("[presign-guard-wallet] AC2 approval refused: the signature is not from the owner's account");
      return false;
    }
    return { approved: true, proof: { via: "ac2", owner: pinned, id, payload: text, signature: msg.body.signature, signedAt: new Date(now()).toISOString() } };
  };
}
