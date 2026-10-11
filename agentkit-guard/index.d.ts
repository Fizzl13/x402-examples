import type { EvmWalletProvider, SvmWalletProvider, ActionProvider, WalletProvider } from "@coinbase/agentkit";
import type { GuardOptions, GuardControls } from "presign-guard-wallet";

/** Thrown instead of signing. Besides presign-guard-wallet's codes, "unchecked": raw hash signing or the CDP client, which the guard can't see. */
export { PresignBlockedError } from "presign-guard-wallet";

export declare const VERSION: string;

export interface AgentKitGuardOptions extends GuardOptions {
  /** Let sign(hash) through unchecked; on Solana, getKeyPairSigner() and signMessage. Default false. */
  allowRawSign?: boolean;
  /** Hand out getClient() (the CDP SDK client; the CDP swap actions sign with it, around the guard). Default false. */
  allowUnguardedClient?: boolean;
}

/** The wrapped provider: the same provider, with every spending method guarded, plus guard controls. */
export type GuardedWalletProvider<P extends EvmWalletProvider | SvmWalletProvider> = P & { readonly guard: GuardControls };

/** An EVM or Solana (solana-mainnet, solana-devnet) wallet provider behind presign-guard and your limits. */
export declare function guardWalletProvider<P extends EvmWalletProvider | SvmWalletProvider>(provider: P, options: AgentKitGuardOptions): GuardedWalletProvider<P>;

/** Actions get_spending_limits and pause_spending, for the agent itself. */
export declare function walletGuardActionProvider(): ActionProvider<WalletProvider>;
