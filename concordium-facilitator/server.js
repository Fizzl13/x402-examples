// Concordium x402 facilitator (testnet first). Environment:
//   SPONSOR_ADDRESS   the facilitator's Concordium account (pays the fees as sponsor)
//   SPONSOR_KEY       its Ed25519 signing key, hex (set by the owner in Render; never logged)
//   CONCORDIUM_NETWORK  ccd:4221332d34e1694168c2a0c0b3fd0f27 (testnet, default) or the mainnet id
//   CONCORDIUM_NODE   gRPC host (default grpc.testnet.concordium.com), CONCORDIUM_PORT (default 20000)
//   SELLERS           optional: comma-separated payTo accounts it sponsors; empty = any seller
//   DAILY_LIMIT       optional: settlements per day (default 500)
//   WALLET_PROXY      optional: Concordium wallet proxy for the payment history on the page (default per network)
//   PORT              HTTP port (default 10000)
import { buildBasicAccountSigner } from '@concordium/web-sdk';
import { createApp } from './src/app.js';
import { createNode } from './src/node.js';
import { createHistory } from './src/history.js';

const env = process.env;
const network = env.CONCORDIUM_NETWORK?.trim() || 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const sponsor = env.SPONSOR_ADDRESS?.trim();
const key = env.SPONSOR_KEY?.trim();
if (!sponsor || !/^[0-9a-fA-F]{64}$/.test(key ?? '')) {
  console.error('Set SPONSOR_ADDRESS and SPONSOR_KEY (64 hex characters) first.');
  process.exit(1);
}
const node = createNode({ host: env.CONCORDIUM_NODE?.trim() || undefined, port: env.CONCORDIUM_PORT || 20000 });
const app = createApp({
  network, sponsor, node,
  sponsorSigner: buildBasicAccountSigner(key),
  sellers: (env.SELLERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  dailyLimit: Number(env.DAILY_LIMIT || 500),
  history: createHistory({ network, sponsor, url: env.WALLET_PROXY?.trim() || undefined }),
});
app.listen(Number(env.PORT || 10000), () => console.log(`[facilitator] ${network}, sponsor ${sponsor}, port ${env.PORT || 10000}`));
