// Finding agents by website, and checking that a website really vouches for them.
//
// An operator gives agent.url when an exam starts, but anyone can type any address there. So a website vouches for its
// agents itself: https://<site>/.well-known/agent-safety.json lists the operator wallets that run agents for it:
//
//   { "operators": ["0x…"] }
//
// An agent whose operator wallet is in that list is "verified" for the site; any other agent that names the site is
// listed as "not verified". The exam fetches that one file, from a public address only: https on port 443, a dotted
// host name (no IP address, no localhost), every address the name resolves to checked against private and reserved
// ranges at connection time (so a name can't be pointed at an internal address in between), no redirects, at most
// 16 KB, 5 seconds. Answers are kept 10 minutes.

import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { isAddress } from "viem";

export const WELL_KNOWN = "/.well-known/agent-safety.json";
const MAX_BYTES = 16 * 1024;
const TIMEOUT_MS = 5000;

// A site as typed ("Example.com", "https://www.example.com/agents", "example.com:443") as its host name, without
// "www.": example.com. Null for anything that is not a public DNS name.
export function siteHost(input) {
  let raw = String(input ?? "").trim().toLowerCase();
  if (!raw || raw.length > 300) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) raw = `https://${raw}`;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^www\./, "").replace(/\.$/, "");
  if (host.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (net.isIP(host) || /(^|\.)(localhost|local|internal|lan|home|arpa|test|invalid|example)$/.test(host)) return null;
  if (host.split(".").some((l) => !l || l.length > 63 || l.startsWith("-") || l.endsWith("-"))) return null;
  return host;
}

// True for an address the exam must never connect to: private, loopback, link-local, shared, reserved, multicast.
export function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith("64:ff9b:") || s.startsWith("2001:db8");
  }
  return true;
}

// dns.lookup that refuses private addresses; used as the connection's own lookup, so the address checked is the one
// connected to.
export function publicLookup(lookup = dns.lookup) {
  return (hostname, options, cb) => {
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err);
      const list = [].concat(addresses || []);
      if (!list.length || list.some((a) => isPrivateAddress(a.address))) return cb(Object.assign(new Error("refused: the site resolves to a private address"), { code: "EPRIVATE" }));
      if (options && options.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

// GET https://<host>/.well-known/agent-safety.json; { status, text? }. status: ok, missing (404, a redirect, or not
// JSON-sized), unreachable.
function fetchWellKnown(host, { lookup } = {}) {
  return new Promise((resolve) => {
    const req = https.get({ host, port: 443, path: WELL_KNOWN, headers: { accept: "application/json", "user-agent": "agent-safety-exam (exam.fizzl.eu)" }, lookup: publicLookup(lookup), timeout: TIMEOUT_MS, maxHeaderSize: 16384 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ status: "missing", http: res.statusCode });
      }
      let size = 0;
      const chunks = [];
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy();
          resolve({ status: "missing", reason: "larger than 16 KB" });
        } else chunks.push(c);
      });
      res.on("end", () => resolve({ status: "ok", text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", () => resolve({ status: "unreachable" }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ status: "unreachable", reason: err.code === "EPRIVATE" ? "private address" : undefined }));
  });
}

// The operator wallets a file lists (lowercase), or null when it isn't a valid file.
export function operatorsOf(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(j?.operators) ? j.operators : null;
  if (!list) return null;
  return list.filter((a) => typeof a === "string" && isAddress(a, { strict: false })).slice(0, 50).map((a) => a.toLowerCase());
}

// verify(host) → { file, status: "found" | "missing" | "invalid" | "unreachable", operators: [...] }, cached 10 min.
export function createSiteVerifier({ fetchFile = fetchWellKnown, now = () => Date.now(), ttlMs = 10 * 60 * 1000, lookup } = {}) {
  const cache = new Map();
  return async function verify(host) {
    const hit = cache.get(host);
    if (hit && hit.until > now()) return hit.value;
    const got = await fetchFile(host, { lookup });
    const ops = got.status === "ok" ? operatorsOf(got.text) : null;
    const value = { file: `https://${host}${WELL_KNOWN}`, status: got.status === "ok" ? (ops ? "found" : "invalid") : got.status, operators: ops || [] };
    if (cache.size > 2000) cache.clear();
    cache.set(host, { until: now() + ttlMs, value });
    return value;
  };
}
