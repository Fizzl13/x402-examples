import type { EvmWalletProvider, ActionProvider, WalletProvider } from "@coinbase/agentkit";
import type { GuardOptions, GuardControls } from "presign-guard-wallet";

/** Thrown instead of signing. Besides presign-guard-wallet's codes, "unchecked": raw hash signing or the CDP client, which the guard can't see. */
export { PresignBlockedError } from "presign-guard-wallet";

export declare const VERSION: string;

export interface AgentKitGuardOptions extends GuardOptions {
  /** Let sign(hash) through unchecked. Default false. */
  allowRawSign?: boolean;
  /** Hand out getClient() (the CDP SDK client; the CDP swap actions sign with it, around the guard). Default false. */
  allowUnguardedClient?: boolean;
}

/** The wrapped provider: the same provider, with every spending method guarded, plus guard controls. */
export type GuardedWalletProvider<P extends EvmWalletProvider> = P & { readonly guard: GuardControls };

export declare function guardWalletProvider<P extends EvmWalletProvider>(provider: P, options: AgentKitGuardOptions): GuardedWalletProvider<P>;

/** Actions get_spending_limits and pause_spending, for the agent itself. */
export declare function walletGuardActionProvider(): ActionProvider<WalletProvider>;
