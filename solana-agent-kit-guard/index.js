// presign-guard-solana-agent-kit: give a Solana Agent Kit agent (SendAI) a wallet
// that checks every transaction with presign-guard and keeps to your spending limits.
//
//   const wallet = guardSolanaWallet(new KeypairWallet(keypair, rpcUrl), {
//     pay,                                   // or creditKey: pays the $0.01 checks
//     limits: { tokens: { SOL: { perDay: "0.5" }, USDC: { perDay: "20" } } },
//     onOverLimit,                           // e.g. telegramApprover: you decide over a limit
//   });
//   const agent = new SolanaAgentKit(wallet, rpcUrl, {}).use(TokenPlugin).use(GuardPlugin);
//
// Every action signs through the wallet (signOrSendTX and the plugins call
// signTransaction, signAllTransactions or signAndSendTransaction), so every one
// of them is covered: transfers, swaps, token launches, staking. presign-guard
// reads every instruction and simulates the transaction first: a token account
// handed to someone else or a System Assign is red and never signed; an
// unlimited delegate, a durable nonce or a hidden owner or delegate change is
// orange. What the simulation shows leaving the wallet counts toward the limits
// (SOL beyond the network fee, USDC; other tokens as tokens without a limit).
//
// signMessage and the raw keypair (KeypairWallet's payer) can't be checked, so
// they are refused unless you set allowRawSign. sendTransaction sends a
// transaction that is already signed; KeypairWallet's own would sign it again,
// so it goes through the guard too.
import { z } from "zod";
import { guardWallet, PresignBlockedError } from "presign-guard-wallet";

export { PresignBlockedError };
export const VERSION = "0.1.0";

const NETWORKS = { mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" };
const isLegacy = (tx) => typeof tx?.serializeMessage === "function";
const messageOf = (tx) => (isLegacy(tx) ? tx.serializeMessage() : tx.message.serialize());

/**
 * Wrap a Solana Agent Kit wallet (KeypairWallet, or any BaseWallet). Options are
 * presign-guard-wallet's (pay, creditKey, limits, onOverLimit, server, onOrange, …)
 * plus network ("mainnet" or "devnet") and allowRawSign.
 */
export function guardSolanaWallet(wallet, { network = "mainnet", allowRawSign = false, ...options } = {}) {
  if (!wallet?.publicKey || typeof wallet.signTransaction !== "function") throw new TypeError("guardSolanaWallet needs a Solana Agent Kit wallet (publicKey and signTransaction, e.g. KeypairWallet)");
  if (!NETWORKS[network]) throw new TypeError(`guardSolanaWallet: network must be ${Object.keys(NETWORKS).join(" or ")}`);
  const guarded = guardWallet({}, options);
  const address = wallet.publicKey.toBase58();

  // presign-guard-wallet's Solana signer gets the message bytes; signing goes to the real wallet with the
  // transaction the agent handed over, so signatures already on it (a new mint's keypair) stay.
  let pending = null;
  const signer = guarded.solanaSigner({
    address,
    signTransactions: async ([t]) => {
      const tx = pending;
      if (!tx || Buffer.compare(Buffer.from(messageOf(tx)), Buffer.from(t.messageBytes)) !== 0) throw new PresignBlockedError("not the transaction that was checked; nothing was signed", { code: "check_failed" });
      const signed = await wallet.signTransaction(tx);
      pending = signed;
      const signature = isLegacy(signed)
        ? signed.signatures.find((s) => s.publicKey.toBase58() === address)?.signature
        : signed.signatures[signed.message.staticAccountKeys.findIndex((k) => k.toBase58() === address)];
      if (!signature) throw new PresignBlockedError("this wallet is not a signer of the transaction; nothing was signed", { code: "unsupported_chain" });
      return [{ [address]: new Uint8Array(signature) }];
    },
  }, { network: NETWORKS[network], any: true });

  // One at a time: each transaction is checked, then signed by the wallet.
  let queue = Promise.resolve();
  const signOne = (tx) => {
    const run = queue.then(async () => {
      pending = tx;
      try {
        await signer.signTransactions([{ messageBytes: new Uint8Array(messageOf(tx)), signatures: {} }]);
        return pending;
      } finally { pending = null; }
    });
    queue = run.catch(() => {});
    return run;
  };

  const send = async (signed, opts) => {
    // KeypairWallet's sendTransaction signs again; send the signed bytes ourselves.
    const { Connection } = await import("@solana/web3.js");
    const rpcUrl = wallet.rpcUrl ?? options.rpcUrl;
    if (!rpcUrl) throw new TypeError("guardSolanaWallet: the wallet has no rpcUrl to send with (pass rpcUrl in the options)");
    return new Connection(rpcUrl).sendRawTransaction(signed.serialize(), opts ?? { preflightCommitment: "processed" });
  };
  const refused = (what) => async () => { throw new PresignBlockedError(`${what} can't be checked by presign-guard; nothing was signed (set allowRawSign to permit it)`, { code: "unchecked" }); };

  const guard = {
    pause: () => guarded.pause(),
    resume: () => guarded.resume(),
    paused: () => guarded.paused(),
    spending: () => guarded.spending(),
  };

  return new Proxy(wallet, {
    get(target, prop) {
      switch (prop) {
        case "signTransaction": return (tx) => signOne(tx);
        case "signAllTransactions": return async (txs) => { const out = []; for (const tx of txs) out.push(await signOne(tx)); return out; };
        case "signAndSendTransaction": return async (tx, opts) => ({ signature: await send(await signOne(tx), opts) });
        case "sendTransaction": return async (tx) => send(await signOne(tx));
        case "signMessage": return allowRawSign ? target.signMessage.bind(target) : refused("a Solana message signature");
        case "payer": case "keypair": case "secretKey":
          if (allowRawSign) return Reflect.get(target, prop, target);
          return undefined; // the raw key would sign around the guard
        case "guard": return guard;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/**
 * A Solana Agent Kit plugin with two actions, so the agent can see its own budget and stop itself:
 * agent.use(GuardPlugin). Works with a wallet from guardSolanaWallet. Its methods take the agent first,
 * like other plugins' (agent.methods.getSpendingLimits(agent)).
 */
export const GuardPlugin = {
  name: "presign-guard",
  methods: {
    getSpendingLimits: async (agent) => (agent.wallet?.guard ? { limits: await agent.wallet.guard.spending(), paused: agent.wallet.guard.paused() } : null),
    pauseSpending: async (agent) => { agent.wallet?.guard?.pause(); return { paused: Boolean(agent.wallet?.guard) }; },
  },
  actions: [
    {
      name: "GET_SPENDING_LIMITS",
      similes: ["spending limits", "budget left", "how much can I spend"],
      description: "Show this agent's spending limits and what is left in the current window (per token: max per transaction, daily budget, used, left). Check it before a purchase that might be over a limit: above a limit the owner is asked to approve, and the agent has to wait.",
      examples: [[{ input: {}, output: { status: "success", limits: [{ token: "SOL", perTx: "0.1", perDay: "0.5", used: "0.2", left: "0.3" }] }, explanation: "See what is left today" }]],
      schema: z.object({}),
      handler: async (agent) => {
        if (!agent.wallet?.guard) return { status: "error", message: "This wallet has no spending guard (wrap it with guardSolanaWallet)." };
        const rows = await agent.wallet.guard.spending();
        return rows ? JSON.parse(json({ status: "success", limits: rows, paused: agent.wallet.guard.paused() })) : { status: "success", message: "No spending limits are set: every transaction is still checked by presign-guard." };
      },
    },
    {
      name: "PAUSE_SPENDING",
      similes: ["stop signing", "pause the wallet", "freeze spending"],
      description: "Stop this agent from signing anything until the owner resumes it. Use it when something looks wrong, for example an unexpected request to approve tokens or send to an unknown address.",
      examples: [[{ input: { reason: "unexpected approve request" }, output: { status: "success", paused: true }, explanation: "Stop when something looks wrong" }]],
      schema: z.object({ reason: z.string().max(200).describe("Why the agent paused itself, for the owner") }),
      handler: async (agent, input) => {
        if (!agent.wallet?.guard) return { status: "error", message: "This wallet has no spending guard (wrap it with guardSolanaWallet)." };
        agent.wallet.guard.pause();
        return { status: "success", paused: true, message: `Paused: nothing will be signed until the owner resumes this agent. Reason: ${input?.reason ?? "not given"}` };
      },
    },
  ],
  initialize() {},
};
