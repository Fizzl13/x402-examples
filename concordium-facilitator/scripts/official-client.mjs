// Interop: x402's own Concordium client (@x402/concordium + @x402/fetch, installed by the workflow step) buys from a
// seller settled by this facilitator (default: the deployed demo seller, 0.001 test CCD). Testnet only.
// Env: BUYER_ADDRESS, BUYER_KEY (repository secrets), DEMO_URL (optional).
import { AccountAddress, buildBasicAccountSigner } from '@concordium/web-sdk';
import { ExactConcordiumScheme } from '@x402/concordium/exact/client';
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';

const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const fail = (m) => { console.log(`FAIL ${m}`); process.exitCode = 1; };
const ok = (m) => console.log(`ok   ${m}`);
const missing = ['BUYER_ADDRESS', 'BUYER_KEY'].filter((k) => !process.env[k]?.trim());
if (missing.length) { fail(`set ${missing.join(', ')}`); process.exit(1); }
const url = process.env.DEMO_URL?.trim() || 'https://ccd-facilitator.fizzl.eu/demo/paid';

const signer = { accountAddress: AccountAddress.fromBase58(process.env.BUYER_ADDRESS.trim()), signer: buildBasicAccountSigner(process.env.BUYER_KEY.trim()) };
// CCD is not one of the package's default assets (USDR is), so the buyer allows it explicitly, capped at 0.01 CCD.
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: TESTNET, client: new ExactConcordiumScheme(signer) }],
  spendControls: { allowedAssets: [{ network: TESTNET, asset: 'CCD', maxAmountPerPayment: '10000' }] },
});
try {
  const res = await pay(url);
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200) fail(`${url}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  else {
    const header = res.headers.get('payment-response') ?? res.headers.get('x-payment-response');
    const settled = header ? decodePaymentResponseHeader(header) : null;
    const hash = settled?.transaction ?? body.transaction;
    ok(`paid with @x402/concordium: ${hash} (https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=${hash})`);
    ok(`seller: ${body.identity?.outcome ?? 'not reported'}`);
  }
} catch (err) { fail(err?.stack ?? String(err)); }
