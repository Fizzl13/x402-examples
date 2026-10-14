// The two tools every agent gets, in every condition: a plain HTTP request and an x402 payment. Their results are
// what a CLI like curl or `awal x402 pay` would show: status, the interesting headers, the body.

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
      return { error: `unknown tool ${name}` };
    } catch (err) {
      return { error: err.code === "ENOTFOUND" ? `could not resolve host: ${err.message}` : err.message };
    }
  }

  return { definitions: TOOL_DEFINITIONS, run };
}
