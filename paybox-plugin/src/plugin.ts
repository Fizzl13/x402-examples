// Fizzl for PayBox: check before your agent signs or pays, and buy the right API for a need.
// Free tools read Fizzl's public data directly. Paid tools return an x402 proposal: PayBox fetches the live 402,
// shows the price, and pays only after the user approves (USDC on Base, or on Solana). The plugin never signs or pays.
// Network hosts to configure in the PayBox portal: x402-doctor.fizzl.eu, presign-guard.fizzl.eu, buy.fizzl.eu.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { proposeX402, x402OutputSchema } from "./paybox.js";

const PROTOCOL_VERSION = "2026-07-28";
const DOCTOR = "https://x402-doctor.fizzl.eu";
const PRESIGN = "https://presign-guard.fizzl.eu";
const BUY = "https://buy.fizzl.eu";

// Each route's price in atomic USDC (6 decimals): PayBox refuses a 402 that asks for more.
const PRICE = { preflight: "1000", check: "10000", token: "10000", screen: "10000", buy: "20000" } as const;

const chainInput = z.enum(["base", "solana"]).default("base")
  .describe("Pay with USDC on Base (default) or on Solana; every Fizzl route accepts both.");
const RAIL = { base: "eip155:8453", solana: "solana:mainnet" } as const;

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const httpsUrl = z.url().max(2048).refine((u) => u.startsWith("https://"), "Use an https URL.");

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const proposes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

// A bounded GET of Fizzl's free JSON: the whole hosted call has 10 seconds.
async function getJson(url: string, timeoutMs = 6000): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "fizzl-paybox-plugin/1.0.0" }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: Record<string, unknown>;
  try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 200) }; }
  // 404 is an answer here (an endpoint not in the index yet), not a failure.
  if (!res.ok && res.status !== 404) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return body;
}

function paid(chain: keyof typeof RAIL, url: string, maxAmount: string, body?: Record<string, string | number>) {
  return proposeX402({ chain: RAIL[chain], url, maxAmount, ...(body ? { method: "POST" as const, body } : {}) });
}

const verdictOf = (letter: unknown) => ({ g: "go", c: "caution", n: "no_go", x: "unreachable" } as Record<string, string>)[String(letter)] ?? String(letter);

function createServer() {
  const server = new McpServer(
    { name: "fizzl", version: "1.0.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  server.registerTool(
    "x402_trust_record",
    {
      title: "Trust record of an x402 endpoint (free)",
      description: "Free. The 30-day record of an x402 endpoint in Fizzl's Trust Index, which checks every x402 resource in the CDP Bazaar and five other catalogues daily without paying: on how many days it was payable, its latest verdict (go, caution, no_go or unreachable), and whether others bought it with real USDC and got an answer. Use it before paying an unknown endpoint.",
      inputSchema: z.object({ url: httpsUrl.describe("The x402 endpoint's URL.") }).strict(),
      outputSchema: z.object({ found: z.boolean(), record: z.record(z.string(), z.unknown()) }).strict(),
      annotations: readOnly,
    },
    async ({ url }) => {
      const record = await getJson(`${DOCTOR}/api/trust?url=${encodeURIComponent(url)}`);
      const found = !record.error;
      const text = found
        ? `${url}: payable on ${record.days_payable} of ${record.days_checked} days checked, latest verdict ${verdictOf(record.last)}.`
        : `${url} is not in the Trust Index yet; x402_preflight checks it live.`;
      return { content: [{ type: "text", text }], structuredContent: { found, record } };
    },
  );

  server.registerTool(
    "x402_preflight",
    {
      title: "Check an x402 endpoint before paying ($0.001)",
      description: "Proposes a paid pre-payment check by x402 Doctor ($0.001 in USDC). It reads the endpoint's 402 challenge without paying it and answers go, caution or no_go with reason codes: every payment option (network, token, amount, whether the payout account can receive), the price against the seller's own OpenAPI, the payout address against the OFAC sanctions list, and the endpoint's 30-day record. Optionally give the most you want to pay.",
      inputSchema: z.object({
        url: httpsUrl.describe("The x402 endpoint you are about to pay."),
        maxUsd: z.string().regex(/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/).optional().describe("Your budget in dollars, e.g. \"0.05\": above it the verdict is no_go."),
        chain: chainInput,
      }).strict(),
      outputSchema: x402OutputSchema,
      annotations: proposes,
    },
    async ({ url, maxUsd, chain }) => {
      const query = new URLSearchParams({ url, ...(maxUsd ? { max_usd: maxUsd } : {}) });
      return paid(chain, `${DOCTOR}/api/v1/preflight?${query}`, PRICE.preflight);
    },
  );

  server.registerTool(
    "check_transaction",
    {
      title: "Check an EVM transaction before signing ($0.01)",
      description: "Proposes a paid pre-sign check by presign-guard ($0.01 in USDC) of an EVM transaction your agent is about to sign: green, orange or red with reason codes. It checks the contract and every party (including OFAC sanctions), decodes the call, and with the sender's address simulates it to show every asset that would leave or arrive, including hidden approvals. Run it on a transaction before you approve it in PayBox.",
      inputSchema: z.object({
        chainId: z.union([z.literal(1), z.literal(10), z.literal(56), z.literal(137), z.literal(8453), z.literal(42161)]).describe("EVM chain id: 1, 10, 56, 137, 8453 (Base) or 42161."),
        to: evmAddress.describe("The contract or recipient the transaction calls."),
        value: z.string().regex(/^(0|[1-9][0-9]{0,77})$/).default("0").describe("Native value in wei."),
        data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(24002).default("0x").describe("0x-prefixed calldata."),
        from: evmAddress.optional().describe("The wallet that would send it; with it the transaction is simulated."),
        intent: z.string().max(500).optional().describe("What the agent means to do, in one sentence; a transaction that does more or something else is flagged."),
        chain: chainInput,
      }).strict(),
      outputSchema: x402OutputSchema,
      annotations: proposes,
    },
    async ({ chainId, to, value, data, from, intent, chain }) =>
      paid(chain, `${PRESIGN}/v1/check`, PRICE.check, { type: "transaction", chainId, to, value, data, ...(from ? { from } : {}), ...(intent ? { intent } : {}) }),
  );

  server.registerTool(
    "check_solana_transaction",
    {
      title: "Check a Solana transaction before signing ($0.01)",
      description: "Proposes a paid pre-sign check by presign-guard ($0.01 in USDC) of a Solana transaction (base64, unsigned or signed): every instruction decoded, then simulated, with green, orange or red and reason codes (drains, owner or authority changes, unknown programs, sanctioned parties).",
      inputSchema: z.object({
        transaction: z.string().min(16).max(12000).describe("The base64 wire transaction."),
        intent: z.string().max(500).optional().describe("What the agent means to do, in one sentence."),
        chain: chainInput,
      }).strict(),
      outputSchema: x402OutputSchema,
      annotations: proposes,
    },
    async ({ transaction, intent, chain }) =>
      paid(chain, `${PRESIGN}/v1/check`, PRICE.check, { type: "solana", transaction, ...(intent ? { intent } : {}) }),
  );

  server.registerTool(
    "check_token",
    {
      title: "Check a token before buying or accepting it ($0.01)",
      description: "Proposes a paid token verdict by presign-guard ($0.01 in USDC): honeypot, impersonation of a known token, high tax, mint or freeze authority and more, on EVM chains, Solana, the XRP Ledger and Algorand.",
      inputSchema: z.object({
        tokenChain: z.enum(["base", "ethereum", "arbitrum", "optimism", "polygon", "bsc", "solana", "xrpl", "algorand"]).describe("The chain the token lives on."),
        address: z.string().min(1).max(80).describe("The token contract, Solana mint, XRPL CURRENCY.rIssuer or Algorand asset id."),
        chain: chainInput,
      }).strict(),
      outputSchema: x402OutputSchema,
      annotations: proposes,
    },
    async ({ tokenChain, address, chain }) =>
      paid(chain, `${PRESIGN}/v1/token?${new URLSearchParams({ chain: tokenChain, address })}`, PRICE.token),
  );

  server.registerTool(
    "screen_address",
    {
      title: "Screen an address against OFAC sanctions ($0.01)",
      description: "Proposes a paid sanctions screen by presign-guard ($0.01 in USDC): whether a wallet address (EVM, Solana, Tron, Bitcoin, XRP Ledger, Algorand and other formats) is on the US Treasury's OFAC SDN list, refreshed every 6 hours. Use it before paying or accepting money from an address you don't know.",
      inputSchema: z.object({
        address: z.string().min(20).max(120).describe("The wallet address to screen."),
        chain: chainInput,
      }).strict(),
      outputSchema: x402OutputSchema,
      annotations: proposes,
    },
    async ({ address, chain }) => paid(chain, `${PRESIGN}/v1/screen?${new URLSearchParams({ address })}`, PRICE.screen),
  );

  server.registerTool(
    "pick_api",
    {
      title: "Find the paid API for a need (free)",
      description: "Free. Say what you need in plain words (\"bitcoin price in usd\", \"weather in Amsterdam\"); Fizzl Buy picks the x402 API with the best delivery record for it and returns it with its price and alternatives. buy_answer has Fizzl Buy pay it and return the checked answer.",
      inputSchema: z.object({ need: z.string().min(3).max(300).describe("What you need, in plain words.") }).strict(),
      outputSchema: z.object({ pick: z.record(z.string(), z.unknown()) }).strict(),
      annotations: readOnly,
    },
    async ({ need }) => {
      const pick = await getJson(`${BUY}/v1/pick?${new URLSearchParams({ need })}`, 8000);
      const best = (pick.pick ?? null) as Record<string, unknown> | null;
      const text = best?.url ? `Pick: ${best.url}${best.price_usd != null ? ` ($${best.price_usd} a call)` : ""}` : "No pick for that need right now.";
      return { content: [{ type: "text", text }], structuredContent: { pick } };
    },
  );

  server.registerTool(
    "buy_answer",
    {
      title: "Buy the answer to a need ($0.02)",
      description: "Proposes a paid purchase through Fizzl Buy ($0.02 in USDC, all in): it picks an x402 API with a good delivery record for the need, pays that seller from its own wallet, checks the answer and returns it. One price, and no seller wallet or API key on your side.",
      inputSchema: z.object({
        need: z.string().min(3).max(300).describe("What you need, in plain words."),
        chain: chainInput,
      }).strict(),
      outputSchema: x402OutputSchema,
      annotations: proposes,
    },
    async ({ need, chain }) => paid(chain, `${BUY}/v1/buy`, PRICE.buy, { need }),
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
