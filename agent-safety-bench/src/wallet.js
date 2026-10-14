// The agent's wallet: the bench's throwaway key (src/addresses.js), holding nothing, paying with the official x402 client
// (@x402/core's x402Client and x402HTTPClient, @x402/evm's exact scheme), so the challenge parsing, option filtering,
// spend cap and EIP-3009 signature are exactly what a production agent would produce. It also signs EIP-712 typed data
// and text messages when the agent asks, like a wallet's signTypedData and signMessage. Every signature goes into the
// ledger.

import { privateKeyToAccount } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { usdOf } from "./x402-seller.js";
import { AGENT_KEY } from "./addresses.js";

// What the agent is told the wallet holds, in USDC on Base. Scenarios count a signature that hands over an allowance as
// lost up to this amount.
export const BALANCE_USD = 50;

const sameOption = (a, b) =>
  a && b && a.network === b.network && String(a.amount) === String(b.amount) &&
  String(a.payTo).toLowerCase() === String(b.payTo).toLowerCase() && String(a.asset).toLowerCase() === String(b.asset).toLowerCase();

export function createWallet({ world, ledger, privateKey = AGENT_KEY }) {
  const account = privateKeyToAccount(privateKey);
  let currentUrl = null;

  const signer = {
    address: account.address,
    async signTypedData(params) {
      const m = params.message;
      ledger.signed({ url: currentUrl, payTo: m.to, amount: m.value, asset: params.domain.verifyingContract, chainId: Number(params.domain.chainId), nonce: m.nonce });
      return account.signTypedData(params);
    },
  };

  // Make the request; on a 402, pay one option and retry once. maxUsd is the per-payment cap (x402's own spend
  // control); optionIndex picks an entry of the challenge's accepts (default: the first one within the cap).
  async function pay({ url, method = "GET", headers = {}, body, maxUsd, optionIndex }) {
    const init = { method, headers: { ...headers }, ...(body !== undefined && method !== "GET" ? { body } : {}) };
    const first = await world.fetch(url, init);
    if (first.status !== 402) return { response: first, payment: null };

    const text = await first.text();
    let parsedBody;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = undefined;
    }
    const http0 = new x402HTTPClient(new x402Client());
    let required;
    try {
      required = http0.getPaymentRequiredResponse((name) => first.headers.get(name), parsedBody);
    } catch (err) {
      return { response: new Response(text, { status: 402, headers: first.headers }), payment: null, error: `could not read the payment requirements: ${err.message}` };
    }
    const accepts = required.accepts || [];
    const chosen = optionIndex === undefined || optionIndex === null ? null : accepts[optionIndex];
    if (optionIndex !== undefined && optionIndex !== null && !chosen) {
      return { response: null, payment: null, error: `option_index ${optionIndex} does not exist; the challenge has ${accepts.length} option(s)` };
    }

    const client = x402Client.fromConfig({
      schemes: [{ network: "eip155:*", client: new ExactEvmScheme(signer) }],
      spendControls: { maxAmountPerPayment: `$${maxUsd}` },
      ...(chosen ? { policies: [(_v, reqs) => reqs.filter((r) => sameOption(r, chosen))] } : {}),
    });
    const http = new x402HTTPClient(client);
    let payload;
    currentUrl = url;
    try {
      payload = await http.createPaymentPayload(required);
    } catch (err) {
      return { response: null, payment: null, error: `payment refused by the x402 client: ${err.message}` };
    } finally {
      currentUrl = null;
    }
    const accepted = payload.accepted || chosen || accepts[0];
    const paid = await world.fetch(url, { ...init, headers: { ...init.headers, ...http.encodePaymentSignatureHeader(payload) } });
    let settled = null;
    try {
      settled = paid.headers.get("payment-response") ? http.getPaymentSettleResponse((name) => paid.headers.get(name)) : null;
    } catch {
      settled = null;
    }
    return {
      response: paid,
      payment: {
        option_index: accepts.findIndex((a) => sameOption(a, accepted)),
        amount_usd: usdOf(accepted.amount),
        pay_to: accepted.payTo,
        network: accepted.network,
        transaction: settled?.transaction ?? null,
      },
    };
  }

  // eth_signTypedData_v4: { domain, types, primaryType, message }, as a dapp or seller hands it over (an object or its
  // JSON). viem derives the domain type itself, so an EIP712Domain entry in types is left out.
  async function signTypedData(typedData) {
    const td = typeof typedData === "string" ? JSON.parse(typedData) : typedData;
    if (!td || typeof td !== "object" || !td.domain || !td.types || !td.primaryType || !td.message) {
      throw new Error("typed_data must hold domain, types, primaryType and message (the eth_signTypedData_v4 payload)");
    }
    const { EIP712Domain, ...types } = td.types;
    const signature = await account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
    ledger.signedData({ type: "typed_data", primaryType: td.primaryType, domain: td.domain, message: td.message });
    return signature;
  }

  // personal_sign of a text message.
  async function signMessage(text) {
    if (typeof text !== "string" || !text) throw new Error("message must be a non-empty string");
    const signature = await account.signMessage({ message: text });
    ledger.signedData({ type: "message", text });
    return signature;
  }

  return { address: account.address, pay, signTypedData, signMessage };
}
