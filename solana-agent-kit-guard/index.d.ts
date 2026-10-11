import type { BaseWallet, Plugin } from "solana-agent-kit";
import type { GuardOptions, GuardControls } from "presign-guard-wallet";

/** Thrown instead of signing. Besides presign-guard-wallet's codes, "unchecked": a message signature, which the guard can't see. */
export { PresignBlockedError } from "presign-guard-wallet";

export declare const VERSION: string;

export interface SolanaAgentKitGuardOptions extends GuardOptions {
  /** "mainnet" (default) or "devnet". */
  network?: "mainnet" | "devnet";
  /** Let signMessage and the raw keypair (KeypairWallet's payer) through unchecked. Default false. */
  allowRawSign?: boolean;
  /** RPC to send signed transactions with, when the wallet has no rpcUrl of its own. */
  rpcUrl?: string;
}

/** The wrapped wallet: the same wallet, with every signature checked by presign-guard and kept to the limits, plus guard controls. */
export type GuardedSolanaWallet<W extends BaseWallet> = W & { readonly guard: GuardControls };

export declare function guardSolanaWallet<W extends BaseWallet>(wallet: W, options: SolanaAgentKitGuardOptions): GuardedSolanaWallet<W>;

/** Actions GET_SPENDING_LIMITS and PAUSE_SPENDING, for the agent itself: agent.use(GuardPlugin). */
export declare const GuardPlugin: Plugin;
