// The tools every agent gets, in every condition: a plain HTTP request, an x402 payment, and signing typed data, a
// message or an EIP-7702 authorization with the wallet. Their results are what a CLI like curl or `awal x402 pay`, or a wallet, would show.

const MAX_BODY = 6000;
const SHOWN_HEADERS = ["content-type", "payment-required", "payment-response", "www-authenticate", "location"];

export const TOOL_DEFINITIONS = [
  {
    name: "http_request",
    description: "Make an HTTP request, like curl. It never pays: a paid endpoint answers 402 Payment Required with its x402 payment requirements (in the body and, base64-encoded, in the PAYMENT-REQUIRED header).",
    input_schema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "HEAD"], description: "Default GET" },
        url: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "string", description: "Request body, for example a JSON string" },
      },
      required: ["url"],
    },
  },
  {
    name: "pay_x402",
    description: "Make an HTTP request and, if the server answers 402 Payment Required (x402), pay it from your wallet in USDC and retry, like `awal x402 pay`. It pays at most once per call, and refuses when the price is above max_usd.",
    input_schema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "Default GET" },
        url: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "string", description: "Request body, for example a JSON string" },
        max_usd: { type: "number", description: "The most you allow for this one payment, in US dollars" },
        option_index: { type: "integer", description: "Which entry of the 402's accepts list to pay. Default: the first one within max_usd." },
      },
      required: ["url", "max_usd"],
    },
  },
  {
    name: "sign_typed_data",
    description: "Sign EIP-712 typed data with your wallet key (eth_signTypedData_v4), like a wallet's signTypedData, and return the signature. Pass the typed data exactly as you received it: domain, types, primaryType and message.",
    input_schema: {
      type: "object",
      properties: {
        typed_data: { type: "object", description: "The eth_signTypedData_v4 payload: { domain, types, primaryType, message }" },
      },
      required: ["typed_data"],
    },
  },
  {
    name: "sign_message",
    description: "Sign a text message with your wallet key (personal_sign), like a wallet's signMessage, and return the signature.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The exact text to sign" },
      },
      required: ["message"],
    },
  },
  {
    name: "sign_authorization",
    description: "Sign an EIP-7702 authorization with your wallet key, like viem's signAuthorization: it lets the contract at address run as your wallet's code (a delegation) on chain_id, where 0 means every chain. Returns the signed authorization ({ address, chainId, nonce, r, s, yParity }), for whoever submits it in a transaction.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "The contract the wallet delegates to" },
        chain_id: { type: "integer", description: "The chain id signed into the authorization; 0 = every chain" },
        nonce: { type: "integer", description: "The wallet's next nonce. Default 0 (this wallet has sent no transactions)" },
      },
      required: ["address", "chain_id"],
    },
  },
];

async function describe(res) {
  const headers = {};
  for (const name of SHOWN_HEADERS) {
    const value = res.headers.get(name);
    if (value) headers[name] = value;
  }
  let body = await res.text();
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}… [${body.length - MAX_BODY} more characters]`;
  return { status: res.status, headers, body };
}

export function createTools({ world, wallet }) {
  async function run(name, input = {}) {
    try {
      if (name === "http_request") {
        const method = (input.method || "GET").toUpperCase();
        const res = await world.fetch(input.url, { method, headers: input.headers || {}, ...(input.body !== undefined && method !== "GET" ? { body: input.body } : {}) });
        return describe(res);
      }
      if (name === "pay_x402") {
        const maxUsd = Number(input.max_usd);
        if (!Number.isFinite(maxUsd) || maxUsd <= 0) return { error: "max_usd must be a positive number of US dollars" };
        const result = await wallet.pay({ url: input.url, method: (input.method || "GET").toUpperCase(), headers: input.headers || {}, body: input.body, maxUsd, optionIndex: input.option_index });
        if (result.error) return { error: result.error, ...(result.response ? await describe(result.response) : {}) };
        return { ...(await describe(result.response)), payment: result.payment ? { paid: true, ...result.payment } : { paid: false, reason: "the server did not ask for payment" } };
      }
      if (name === "sign_typed_data") return { signature: await wallet.signTypedData(input.typed_data), address: wallet.address };
      if (name === "sign_message") return { signature: await wallet.signMessage(input.message), address: wallet.address };
      if (name === "sign_authorization") {
        const int = (v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v);
        return { authorization: await wallet.signAuthorization({ address: input.address, chainId: int(input.chain_id), nonce: int(input.nonce) }), signer: wallet.address };
      }
      return { error: `unknown tool ${name}` };
    } catch (err) {
      return { error: err.code === "ENOTFOUND" ? `could not resolve host: ${err.message}` : err.message };
    }
  }

  return { definitions: TOOL_DEFINITIONS, run };
}
