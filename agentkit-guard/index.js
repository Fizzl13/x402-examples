// presign-guard-agentkit: give a Coinbase AgentKit agent a wallet that checks
// every signature with presign-guard and keeps to your spending limits.
//
//   const walletProvider = guardWalletProvider(await CdpEvmWalletProvider.configureWithWallet(...), {
//     pay,                                   // or creditKey: pays the $0.01 checks
//     server: { url, key },                  // or limits + onOverLimit (e.g. telegramApprover)
//   });
//   const agentkit = await AgentKit.from({ walletProvider, actionProviders: [..., walletGuardActionProvider()] });
//
// Every action that spends goes through the wallet provider, so every one of
// them is covered: sendTransaction (transfers, swaps, approvals), signTypedData
// (Permit, Permit2, x402 payments via toSigner), signTransaction and
// nativeTransfer. A red verdict is never signed; over a limit, the agent waits
// for your approval; when the check or the server can't be reached, nothing is
// signed. The error message goes back to the agent, which tells the user.
//
// Raw hash signing (sign) can't be checked, so it is refused unless you set
// allowRawSign. getClient (the CDP SDK client, which the CDP swap actions use to
// sign on their own) would go around the guard, so it is refused unless you set
// allowUnguardedClient. signMessage (plain text, personal_sign) is not checked,
// as in presign-guard-wallet.
import { EvmWalletProvider, customActionProvider } from "@coinbase/agentkit";
import { z } from "zod";
import { guardWallet, PresignBlockedError } from "presign-guard-wallet";

export { PresignBlockedError };
export const VERSION = "0.1.0";

const SIGN_ONLY = Symbol("signOnly");

/**
 * Wrap an AgentKit EVM wallet provider. Options are presign-guard-wallet's
 * (pay, creditKey, limits, onOverLimit, server, onOrange, …) plus allowRawSign.
 * Build `pay` from the original, unwrapped provider (or use creditKey), so that
 * paying for a check is not itself checked.
 */
export function guardWalletProvider(provider, { allowRawSign = false, allowUnguardedClient = false, ...options } = {}) {
  const evm = provider instanceof EvmWalletProvider || ["sendTransaction", "signTypedData", "signTransaction", "getNetwork"].every((m) => typeof provider?.[m] === "function") && provider.getNetwork()?.protocolFamily === "evm";
  if (!evm) throw new TypeError("guardWalletProvider needs an AgentKit EVM wallet provider (Solana providers aren't covered by presign-guard)");

  // The small wallet shape presign-guard-wallet guards.
  const inner = {
    get chain() { return { id: Number(provider.getNetwork().chainId) }; },
    sendTransaction: (args) => (args?.[SIGN_ONLY] ? provider.signTransaction(strip(args)) : provider.sendTransaction(args)),
    signTypedData: (typedData) => provider.signTypedData(typedData),
  };
  const guarded = guardWallet(inner, options);

  const controls = {
    pause: () => guarded.pause(),
    resume: () => guarded.resume(),
    paused: () => guarded.paused(),
    spending: () => guarded.spending(),
  };

  const proxy = new Proxy(provider, {
    get(target, prop, receiver) {
      switch (prop) {
        case "sendTransaction": return (tx) => guarded.sendTransaction(tx);
        case "signTransaction": return (tx) => guarded.sendTransaction({ ...tx, [SIGN_ONLY]: true });
        case "signTypedData": return (typedData) => guarded.signTypedData(typedData);
        case "nativeTransfer": return async (to, value) => receiver.sendTransaction({ to, value: BigInt(value), data: "0x" });
        case "sign":
          if (allowRawSign) return target.sign.bind(target);
          return async () => { throw new PresignBlockedError("raw hash signing can't be checked by presign-guard; nothing was signed (set allowRawSign to permit it)", { code: "unchecked" }); };
        case "getClient":
          if (allowUnguardedClient || typeof target.getClient !== "function") return Reflect.get(target, prop, target)?.bind?.(target);
          return () => { throw new PresignBlockedError("the CDP client signs without the guard, so it is not handed out; nothing was signed (set allowUnguardedClient to permit it)", { code: "unchecked" }); };
        // Built from the guarded methods, so x402 payments and EIP-1193 callers are covered too.
        case "toSigner": return () => EvmWalletProvider.prototype.toSigner.call(receiver);
        case "toEip1193Provider": // AgentKit 0.11+; a provider's own version would sign around the guard
          return EvmWalletProvider.prototype.toEip1193Provider ? () => EvmWalletProvider.prototype.toEip1193Provider.call(receiver) : undefined;
        case "guard": return controls;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return proxy;
}

function strip(args) {
  const { [SIGN_ONLY]: _, ...rest } = args;
  return rest;
}

const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/**
 * Actions so the agent can see its own budget (and stop itself): add it next
 * to your other action providers. Works with a provider from guardWalletProvider.
 */
export function walletGuardActionProvider() {
  return customActionProvider([
    {
      name: "get_spending_limits",
      description: "Show this agent's spending limits and what is left in the current window (per token: max per transaction, daily budget, used, left). Check it before a purchase that might be over a limit: above a limit the owner is asked to approve, and the agent has to wait.",
      schema: z.object({}),
      invoke: async (walletProvider, _args) => { // two parameters: AgentKit passes the wallet provider only then
        if (!walletProvider?.guard) return "This wallet has no spending guard (wrap it with guardWalletProvider).";
        const rows = await walletProvider.guard.spending();
        if (!rows) return "No spending limits are set: every signature is still checked by presign-guard.";
        return json({ limits: rows, paused: walletProvider.guard.paused() });
      },
    },
    {
      name: "pause_spending",
      description: "Stop this agent from signing anything (transactions, permits, payments) until the owner resumes it. Use it when something looks wrong, for example an unexpected request to approve tokens or pay an unknown address.",
      schema: z.object({ reason: z.string().max(200).describe("Why the agent paused itself, for the owner") }),
      invoke: async (walletProvider, { reason }) => {
        if (!walletProvider?.guard) return "This wallet has no spending guard (wrap it with guardWalletProvider).";
        walletProvider.guard.pause();
        return `Paused: nothing will be signed until the owner resumes this agent. Reason: ${reason}`;
      },
    },
  ]);
}
