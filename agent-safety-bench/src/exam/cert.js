// The result signer tied to Fizzl, not just a key: the Fizzl payout wallet (AUTHORITY, the same wallet that authorises
// x402 Doctor's and presign-guard's receipt signers) signs a certificate with personal_sign over certMessage, saying
// this key may sign the exam's results from a date on. EXAM_SIGNER_CERT = "YYYY-MM-DD:0x<signature>" (made on
// /sign-signer-key in the wallet's browser), checked at start-up, published on /v1/signer and carried in every signed
// result, so anyone who pins only the payout wallet can check a result offline, and a new signing key needs no
// announcement. Same message format as Doctor's (x402-doctor lib/receipt.js), so one verifier works for all three.

import { recoverMessageAddress } from "viem";

export const AUTHORITY = "0x6B0F4651eD42893ab58139938175E4a69f175F25";
export const SERVICE = "agent-benchmark-exam";

export const certMessage = ({ service, signer, valid_from: validFrom }) =>
  `fizzl receipt signer\nservice: ${service}\nsigner: ${signer}\nvalid_from: ${validFrom}`;

export async function certValid(cert, { authority = AUTHORITY, service = SERVICE } = {}) {
  try {
    if (!cert || cert.service !== service) return false;
    if (String(cert.authority).toLowerCase() !== authority.toLowerCase()) return false;
    const recovered = await recoverMessageAddress({ message: certMessage(cert), signature: cert.signature });
    return recovered.toLowerCase() === authority.toLowerCase();
  } catch {
    return false;
  }
}

// The certificate for this signer from EXAM_SIGNER_CERT, or null (none set, or not a valid one for this signer: the
// log says so, without the value's signature).
export async function loadCert(raw, signer, { authority = AUTHORITY, log = console } = {}) {
  const value = String(raw || "").trim().replace(/^["']|["']$/g, "").trim();
  if (!value || !signer) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(0x[0-9a-fA-F]{130})$/.exec(value);
  const cert = m && { service: SERVICE, signer, valid_from: m[1], authority, signature: m[2] };
  if (!cert || !(await certValid(cert, { authority }))) {
    log.warn?.(`[exam] EXAM_SIGNER_CERT ignored: not a valid certificate by ${authority} for ${SERVICE} signer ${signer}`);
    return null;
  }
  return cert;
}

// The page that makes the certificate: open it in the payout wallet's browser, sign, paste the value into Render.
export function signCertPage({ signerPath = "/v1/signer" } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorise the exam signer</title>
<meta name="robots" content="noindex">
<style>
  :root { --bg: #020708; --card: #041212; --text: #f4f8f7; --muted: #a8b5b2; --accent: #61f5c3; --ok: #3fb950; --bad: #f85149; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 1.4rem; margin: 0 0 8px; }
  p { color: var(--muted); }
  .card { background: var(--card); border-radius: 12px; padding: 16px; margin: 16px 0; }
  pre { white-space: pre-wrap; word-break: break-all; background: #0b0f14; border-radius: 8px; padding: 12px; font-size: 0.9rem; color: var(--text); }
  button { background: var(--accent); color: #02100c; border: 0; border-radius: 10px; padding: 12px 18px; font-weight: 600; font-size: 1rem; width: 100%; margin-top: 8px; }
  label { display: block; margin-top: 8px; color: var(--muted); }
  input { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid #30363d; background: #0b0f14; color: var(--text); font-size: 1rem; }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
</style>
</head>
<body>
<main>
  <h1>Authorise the exam signer</h1>
  <p>Signs a certificate with the Fizzl payout wallet that says: this key may sign the Agent Benchmark Exam's results. Anyone who trusts the payout wallet can then check a result without knowing the key. Open this page in your wallet's browser (MetaMask mobile: the browser tab).</p>
  <div class="card">
    <div id="status">Loading the current signer…</div>
    <label for="from">Valid from (UTC date)</label>
    <input id="from" type="date">
    <p>Message to sign:</p>
    <pre id="msg">…</pre>
    <button id="sign" disabled>Sign with the payout wallet</button>
  </div>
  <div class="card" id="result" hidden>
    <p>Put this value in Render → agent-benchmark-exam → Environment as <b>EXAM_SIGNER_CERT</b>, save, and let it redeploy:</p>
    <pre id="cert"></pre>
    <button id="copy">Copy</button>
    <p id="who"></p>
  </div>
  <p>The signature only authorises a key to sign exam results: it moves no funds and approves nothing. After the redeploy, <a href="${signerPath}" style="color:var(--accent)">the signer page</a> shows the certificate.</p>
</main>
<script>
  const AUTHORITY = "${AUTHORITY}";
  const SERVICE = "${SERVICE}";
  const $ = (id) => document.getElementById(id);
  let signer = null;
  $("from").value = new Date().toISOString().slice(0, 10);
  const message = () => "fizzl receipt signer\\nservice: " + SERVICE + "\\nsigner: " + signer + "\\nvalid_from: " + $("from").value;
  const render = () => { $("msg").textContent = signer ? message() : "…"; };
  $("from").addEventListener("input", render);
  fetch("${signerPath}").then((r) => r.json()).then((d) => {
    if (!d.signer) { $("status").innerHTML = '<span class="bad">Results are not signed: set EXAM_SIGNING_KEY first.</span>'; return; }
    signer = d.signer;
    const has = d.certificate && d.certificate.signer === signer;
    $("status").innerHTML = "Current signer: <b>" + signer + "</b><br>" + (has ? '<span class="ok">Already certified (valid from ' + d.certificate.valid_from + ').</span>' : "Not certified yet.");
    $("sign").disabled = false;
    render();
  }).catch(() => { $("status").innerHTML = '<span class="bad">Could not load the signer.</span>'; });
  $("sign").addEventListener("click", async () => {
    if (!window.ethereum) { alert("No wallet found. Open this page in your wallet's browser."); return; }
    try {
      const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
      const hex = "0x" + Array.from(new TextEncoder().encode(message())).map((b) => b.toString(16).padStart(2, "0")).join("");
      const signature = await window.ethereum.request({ method: "personal_sign", params: [hex, account] });
      $("cert").textContent = $("from").value + ":" + signature;
      $("who").innerHTML = account.toLowerCase() === AUTHORITY.toLowerCase()
        ? '<span class="ok">Signed by the payout wallet.</span>'
        : '<span class="bad">Signed by ' + account + ', not the payout wallet ' + AUTHORITY + ': switch accounts and sign again, or the certificate will be ignored.</span>';
      $("result").hidden = false;
    } catch (err) {
      alert("Not signed: " + (err.message || err));
    }
  });
  $("copy").addEventListener("click", () => navigator.clipboard.writeText($("cert").textContent));
</script>
</body>
</html>`;
}
