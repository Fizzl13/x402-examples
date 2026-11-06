// The facilitator's home page (GET /): what it is, its live state, and how a seller or buyer uses it.
// One self-contained HTML page (no external scripts or fonts), light and dark.
import { NETWORKS } from './scheme.js';

const NAMES = {
  'ccd:9dd9ca4d19e9393877d2c44b70f89acb': { name: 'Concordium mainnet', scan: 'https://ccdscan.io' },
  'ccd:4221332d34e1694168c2a0c0b3fd0f27': { name: 'Concordium testnet', scan: 'https://testnet.ccdscan.io' },
};
// The first payment this facilitator settled, per network (shown as proof it works).
const FIRST = {
  'ccd:4221332d34e1694168c2a0c0b3fd0f27': { tx: '1b2edc98d09914df0df49a96ff3371cdd6edbdf4c9390ce5d9e522b093254c98', when: '6 Nov 2026', what: '0.001 CCD, buyer fee 0' },
};
const SOURCE = 'https://github.com/Fizzl13/x402-examples/tree/main/concordium-facilitator';
const SPEC = 'https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_concordium.md';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (s) => (s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);

// The latest sponsored payments, from the chain (src/history.js).
function recentTable(history, net, tx, acct) {
  if (!history?.recent?.length) return '';
  const rows = history.recent.map((p) => `<tr><td>${p.time ? esc(p.time.slice(0, 16).replace('T', ' ')) : ''}</td><td>${p.amount !== null ? `${esc(p.amount)} ${esc(p.asset ?? '')}` : '–'}</td><td><a href="${esc(acct(p.to ?? ''))}">${esc(short(p.to ?? ''))}</a></td><td>${esc(p.fee_ccd ?? '')}</td><td><a href="${esc(tx(p.tx))}">${esc(short(p.tx))}</a>${p.ok ? '' : ' (failed)'}</td></tr>`).join('');
  return `<h2>Latest payments</h2><p>Read from the chain: every transfer this facilitator's account sponsored. The buyer paid no fee; the fee column is what the sponsor paid (${esc(net.name)} CCD).</p><div class="scroll"><table class="pay"><tr><th>UTC</th><th>Amount</th><th>To</th><th>Fee</th><th>Transaction</th></tr>${rows}</table></div>`;
}

export function page({ network, sponsor, settledToday = 0, dailyLimit = 500, sellersOnly = false, base = '', history = null, identityMode = 'report', demo = false }) {
  if (!NETWORKS[network]) throw new Error(`unknown network ${network}`);
  const net = NAMES[network] ?? { name: network, scan: 'https://ccdscan.io' };
  const first = FIRST[network];
  const tx = (h) => `${net.scan}/?dcount=1&dentity=transaction&dhash=${h}`;
  const acct = (a) => `${net.scan}/?dcount=1&dentity=account&daddress=${a}`;
  const url = base || 'https://&lt;this host&gt;';
  const requirements = JSON.stringify({
    scheme: 'exact', network, amount: '10000', asset: 'CCD', payTo: '<your Concordium account>',
    maxTimeoutSeconds: 120, extra: { feePayer: sponsor },
  }, null, 2);
  const plt = JSON.stringify({ asset: 'EURR', amount: '10000', extra: { feePayer: sponsor } }, null, 2);

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Concordium x402 facilitator</title>
<meta name="description" content="An x402 facilitator for Concordium: the buyer signs a CCD or PLT transfer, the facilitator sponsors it and pays the fee.">
<style>
:root { --bg:#f6f7fb; --card:#ffffff; --text:#141a26; --muted:#5b6578; --line:#e1e5ee; --accent:#2f5bea; --ok:#13865a; --code:#eef1f7; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#0b0f1a; --card:#121827; --text:#e8ecf5; --muted:#9aa4b8; --line:#232b3d; --accent:#7aa2ff; --ok:#5ee0a0; --code:#0f1422; } }
:root[data-theme="dark"] { --bg:#0b0f1a; --card:#121827; --text:#e8ecf5; --muted:#9aa4b8; --line:#232b3d; --accent:#7aa2ff; --ok:#5ee0a0; --code:#0f1422; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 system-ui,-apple-system,"Segoe UI",Inter,sans-serif; }
main { max-width:860px; margin:0 auto; padding:40px 16px 64px; }
.tag { display:inline-block; font-size:12px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); border:1px solid var(--line); border-radius:999px; padding:4px 12px; }
h1 { font-size:clamp(30px,6vw,44px); line-height:1.1; margin:16px 0 10px; letter-spacing:-.02em; }
h2 { font-size:20px; margin:40px 0 12px; }
p { margin:0 0 12px; color:var(--muted); }
p strong, li strong { color:var(--text); }
a { color:var(--accent); }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-top:24px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; min-width:0; }
.k { font-size:12px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
.v { font-size:18px; font-weight:700; margin-top:4px; overflow-wrap:anywhere; }
.ok { color:var(--ok); }
ol { padding-left:20px; color:var(--muted); } ol li { margin-bottom:8px; }
pre { background:var(--code); border:1px solid var(--line); border-radius:12px; padding:14px; overflow-x:auto; font:13px/1.5 ui-monospace,"JetBrains Mono",Menlo,monospace; margin:0 0 12px; }
code { font-family:ui-monospace,"JetBrains Mono",Menlo,monospace; font-size:.92em; }
table { width:100%; border-collapse:collapse; font-size:15px; }
td { border-top:1px solid var(--line); padding:10px 8px 10px 0; vertical-align:top; color:var(--muted); }
td:first-child { white-space:nowrap; color:var(--text); }
th { text-align:left; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); padding:8px 8px 8px 0; font-weight:600; }
.scroll { overflow-x:auto; }
table.pay td, table.pay th { white-space:nowrap; padding-right:16px; }
table.pay td:first-child { color:var(--muted); }
footer { margin-top:48px; font-size:14px; color:var(--muted); }
</style></head>
<body><main>
<span class="tag">${esc(net.name)} · x402</span>
<h1>x402 facilitator for Concordium</h1>
<p>An independent facilitator for x402's <a href="${SPEC}">exact scheme on Concordium</a>, the one <code>@x402/concordium</code> clients use. The buyer signs a transfer of <strong>CCD or a protocol-level token</strong> (PLT, e.g. EURR) to the seller and names this facilitator as fee payer (sponsor). The facilitator checks it, co-signs as sponsor, pays the fee and submits it. <strong>The buyer pays no fees</strong>, and the facilitator never holds anyone's funds.</p>

<div class="grid">
  <div class="card"><div class="k">Status</div><div class="v ok">Live</div></div>
  <div class="card"><div class="k">Network</div><div class="v">${esc(net.name)}</div></div>
  <div class="card"><div class="k">Sponsor</div><div class="v"><a href="${esc(acct(sponsor))}">${esc(short(sponsor))}</a></div></div>
  <div class="card"><div class="k">Payments sponsored</div><div class="v">${history ? `${Number(history.sponsored)}${history.partial ? '+' : ''}` : '–'}</div></div>
  <div class="card"><div class="k">Today</div><div class="v">${history ? Number(history.sponsored_today) : Number(settledToday)} <span style="font-weight:400;color:var(--muted);font-size:14px">/ ${Number(dailyLimit)} a day</span></div></div>
</div>
${recentTable(history, net, tx, acct)}
${first ? `<p style="margin-top:16px">First payment settled ${esc(first.when)}: <a href="${esc(tx(first.tx))}">${esc(short(first.tx))}</a> (${esc(first.what)}).</p>` : ''}

<h2>How a payment works</h2>
<ol>
  <li>The seller's API answers <code>402</code> with a Concordium option that names this facilitator in <code>extra.feePayer</code>.</li>
  <li>The buyer signs a sponsored transfer (account transaction v1) of exactly that amount to the seller and sends it in the <code>PAYMENT-SIGNATURE</code> header.</li>
  <li>The seller posts it to <code>/verify</code>, then <code>/settle</code>: this facilitator checks amount, payee, signature, nonce, expiry and balance, co-signs as sponsor, submits it and waits until it is final.</li>
</ol>

<h2>Who you pay: checked with Concordium</h2>
<p>Every Concordium account is opened from an identity a regulated identity provider verified. Before sponsoring a payment this facilitator reads <strong>the seller's own credential</strong> (which provider, valid until when) and, when the seller's endpoint shows a Concordium badge in its Agent Card, checks <strong>its agent in Concordium's Agent Registry</strong>: active, its anchored card unchanged, this endpoint listed, and the payTo its registered agent wallet. The answer rides along in every <code>/verify</code> and <code>/settle</code> response as <code>extensions["concordium-identity"]</code>: <code>verified-agent</code>, <code>identity-backed</code>, <code>expired</code> or <code>not-read</code>.</p>
<p><strong>A zero-knowledge proof about the person behind the payTo.</strong> A seller's owner can prove, from their own Concordium wallet, facts such as <em>18 or older</em> or <em>lives in the EU</em> without revealing them (<a href="https://x402-doctor.fizzl.eu/concordium-proof.html">make one</a>), tied to the payTo and the site, and serve it at <code>/.well-known/concordium-proof.json</code>. This facilitator verifies it against the chain with its own node, checks that it came from the payTo account's own credential, and reports the proven facts as <code>proof</code>; nothing else about the person is known to it.</p>
<p>${identityMode === 'agent' ? 'This instance sponsors <strong>only verified agents</strong>: payments to any other payTo are refused before anything is signed.' : identityMode === 'proof' ? 'This instance sponsors <strong>only sellers with a verified proof</strong>: payments to any other payTo are refused before anything is signed.' : identityMode === 'off' ? 'Identity checks are off on this instance.' : 'This instance reports it; set <code>IDENTITY=agent</code> to sponsor only verified agents, or <code>IDENTITY=proof</code> to sponsor only sellers with a verified proof.'} Check a seller before going live: <code>GET /identity?url=&lt;paid endpoint&gt;&amp;payTo=&lt;account&gt;</code>.</p>
${demo ? `<p><strong>Try it:</strong> <a href="/demo/paid"><code>/demo/paid</code></a> is a demo seller on testnet, paid at the wallet of agent #993 in Concordium's Agent Registry, whose <a href="/.well-known/agent-card.json">Agent Card</a> is pinned on chain, and whose owner <a href="/.well-known/concordium-proof.json">proved</a> they are an adult living in the EU. It answers 402; pay it with any x402 client for Concordium and the answer shows what this facilitator found about the seller.</p>` : ''}

<h2>For sellers: the 402 option</h2>
<p>Add this to <code>accepts[]</code> (here 0.01 CCD; amounts are in the smallest unit, 6 decimals for CCD):</p>
<pre>${esc(requirements)}</pre>
<p>For a PLT, set its token id (the decimals are read from the chain):</p>
<pre>${esc(plt)}</pre>
<p>Then use <code>${esc(url)}</code> as your facilitator URL.${sellersOnly ? ' This instance sponsors listed sellers only; ask to be added.' : ''}</p>

<h2>Routes</h2>
<table>
  <tr><td><code>GET /supported</code></td><td>the scheme, network and sponsor account</td></tr>
  <tr><td><code>POST /verify</code></td><td><code>{ paymentPayload, paymentRequirements }</code> → <code>{ isValid, payer }</code> or <code>invalidReason</code></td></tr>
  <tr><td><code>POST /settle</code></td><td>same body → <code>{ success, transaction, network, payer }</code> once final on chain</td></tr>
  <tr><td><code>GET /identity</code></td><td><code>?url=&amp;payTo=</code>: what Concordium says about a seller (credential, registered agent, zero-knowledge proof)</td></tr>
  <tr><td><code>GET /payments</code></td><td>the sponsored payments, read from the chain</td></tr>
  <tr><td><code>GET /health</code></td><td>live state as JSON</td></tr>
</table>

<h2>Spec and code</h2>
<p>The scheme: <a href="${SPEC}">scheme_exact_concordium.md</a> in the x402 repository. On top of its checks this facilitator also caps the energy at what the transfer needs, checks a PLT's pause and allow/deny lists before sponsoring, and has a seller allow-list and a daily limit (<a href="${SOURCE}/SPEC.md">SPEC.md</a>). Code (MIT), tests and a buyer-side helper: <a href="${SOURCE}">github.com/Fizzl13/x402-examples</a>. Built on Concordium's sponsored transactions (protocol 10) with <code>@concordium/web-sdk</code>.</p>

<footer>Made by <a href="https://fizzl.eu">Fizzl</a>. ${network.endsWith('0c0b3fd0f27') ? 'Testnet only: no real funds move.' : ''}</footer>
</main></body></html>`;
}
