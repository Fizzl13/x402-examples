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
// allowUnguardedClient. signMessage (personal_sign) is checked too: a sign-in
// message for another site is red.
//
// Solana wallet providers (SolanaKeypairWalletProvider, CdpSolanaWalletProvider)
// are guarded the same way: signTransaction and signAndSendTransaction (SPL
// transfers, Jupiter swaps), nativeTransfer and the x402 actions (toSigner) go
// through presign-guard, which reads every instruction and simulates the
// transaction; what leaves the wallet counts toward the limits (SOL, USDC).
// getKeyPairSigner (the raw key) and signMessage can't be checked, so they are
// refused unless you set allowRawSign.
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { EvmWalletProvider, customActionProvider } from "@coinbase/agentkit";
import { z } from "zod";
import { guardWallet, PresignBlockedError } from "presign-guard-wallet";

export { PresignBlockedError };
export const VERSION = "0.3.0";

// AgentKit's Solana network ids and the x402 (CAIP-2) ids presign-guard-wallet uses.
const SOLANA_NETWORKS = { "solana-mainnet": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" };

const SIGN_ONLY = Symbol("signOnly");

/**
 * Wrap an AgentKit EVM wallet provider. Options are presign-guard-wallet's
 * (pay, creditKey, limits, onOverLimit, server, onOrange, …) plus allowRawSign.
 * Build `pay` from the original, unwrapped provider (or use creditKey), so that
 * paying for a check is not itself checked.
 */
export function guardWalletProvider(provider, { allowRawSign = false, allowUnguardedClient = false, ...options } = {}) {
  const family = typeof provider?.getNetwork === "function" ? provider.getNetwork()?.protocolFamily : undefined;
  if (family === "svm" && ["signTransaction", "sendTransaction", "getAddress"].every((m) => typeof provider[m] === "function")) return guardSvmProvider(provider, { allowRawSign, ...options });
  const evm = provider instanceof EvmWalletProvider || ["sendTransaction", "signTypedData", "signTransaction", "getNetwork"].every((m) => typeof provider?.[m] === "function") && family === "evm";
  if (!evm) throw new TypeError("guardWalletProvider needs an AgentKit EVM or Solana wallet provider");

  // The small wallet shape presign-guard-wallet guards.
  const inner = {
    get chain() { return { id: Number(provider.getNetwork().chainId) }; },
    // The sending address goes with each transaction check, so presign-guard simulates it.
    get account() { try { return { address: provider.getAddress() }; } catch { return undefined; } },
    sendTransaction: (args) => (args?.[SIGN_ONLY] ? provider.signTransaction(strip(args)) : provider.sendTransaction(args)),
    signTypedData: (typedData) => provider.signTypedData(typedData),
    // viem's shape ({ message: string | { raw } }) back to AgentKit's (string | bytes).
    signMessage: ({ message }) => provider.signMessage(typeof message === "string" ? message : message.raw),
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
        case "signMessage": return (message) => guarded.signMessage({ message: typeof message === "string" ? message : { raw: message } });
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

/**
 * A Solana wallet provider behind the same guard. Every signature goes through presign-guard-wallet's
 * Solana signer with any: checked (decoded and simulated) and kept to the limits.
 */
function guardSvmProvider(provider, { allowRawSign, ...options }) {
  const network = SOLANA_NETWORKS[provider.getNetwork().networkId];
  if (!network) throw new TypeError(`guardWalletProvider: Solana network ${provider.getNetwork().networkId} is not covered (${Object.keys(SOLANA_NETWORKS).join(", ")})`);
  const web3 = solanaWeb3();
  const guarded = guardWallet({}, options);
  const address = provider.getAddress();

  // The signer presign-guard-wallet guards: it gets @solana/kit-style transactions ({ messageBytes })
  // and has the provider sign them. A transaction the agent handed over keeps its other signatures.
  const handed = new Map();
  const inner = {
    address,
    signTransactions: async (txs) => Promise.all(txs.map(async (t) => {
      const key = Buffer.from(t.messageBytes).toString("base64");
      const vtx = handed.get(key) ?? new web3.VersionedTransaction(web3.VersionedMessage.deserialize(t.messageBytes));
      const signed = await provider.signTransaction(vtx);
      handed.set(key, signed);
      const i = signed.message.staticAccountKeys.findIndex((k) => k.toBase58() === address);
      if (i < 0) throw new PresignBlockedError("the wallet is not a signer of this transaction; nothing was signed", { code: "unsupported_chain" });
      return { [address]: signed.signatures[i] };
    })),
  };
  const signer = guarded.solanaSigner(inner, { network, any: true });
  const signVersioned = async (vtx) => {
    const messageBytes = vtx.message.serialize();
    const key = Buffer.from(messageBytes).toString("base64");
    handed.set(key, vtx);
    try {
      await signer.signTransactions([{ messageBytes, signatures: {} }]);
      return handed.get(key);
    } finally { handed.delete(key); }
  };
  const refused = (what) => async () => { throw new PresignBlockedError(`${what} can't be checked by presign-guard; nothing was signed (set allowRawSign to permit it)`, { code: "unchecked" }); };

  const controls = {
    pause: () => guarded.pause(),
    resume: () => guarded.resume(),
    paused: () => guarded.paused(),
    spending: () => guarded.spending(),
  };

  return new Proxy(provider, {
    get(target, prop, receiver) {
      switch (prop) {
        case "signTransaction": return (vtx) => signVersioned(vtx);
        case "signAndSendTransaction": return async (vtx) => target.sendTransaction(await signVersioned(vtx));
        // The provider's own builds and signs inside itself: rebuilt here so it goes through the guard.
        case "nativeTransfer": return async (to, value) => {
          const payer = target.getPublicKey();
          const { blockhash } = await target.getConnection().getLatestBlockhash();
          const message = web3.MessageV0.compile({
            payerKey: payer,
            recentBlockhash: blockhash,
            instructions: [web3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: new web3.PublicKey(to), lamports: BigInt(value) })],
          });
          return receiver.signAndSendTransaction(new web3.VersionedTransaction(message));
        };
        // The x402 actions pay with this signer: x402 payments and anything else, checked and counted.
        case "toSigner": return async () => signer;
        case "getKeyPairSigner": return allowRawSign ? target.getKeyPairSigner.bind(target) : refused("handing out the private key");
        case "signMessage": return allowRawSign ? target.signMessage.bind(target) : refused("a Solana message signature");
        case "guard": return controls;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// @solana/web3.js as AgentKit itself has it, so the transactions are the classes its actions build.
function solanaWeb3() {
  const here = createRequire(import.meta.url);
  return here(here.resolve("@solana/web3.js", { paths: [dirname(here.resolve("@coinbase/agentkit"))] }));
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
