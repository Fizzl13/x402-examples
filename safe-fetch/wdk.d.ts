/** What wdkEvmSigner needs from a Tether WDK EVM account (@tetherto/wdk-wallet-evm WalletAccountEvm). */
export interface WdkEvmAccount {
  getAddress(): Promise<string>;
  signTypedData(typedData: { domain: Record<string, unknown>; types: Record<string, unknown>; message: Record<string, unknown> }): Promise<string>;
}

/** An x402 EVM signer (for @x402/evm's ExactEvmScheme), signing with the WDK account. */
export interface WdkX402Signer {
  readonly address: `0x${string}`;
  signTypedData(typedData: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<`0x${string}`>;
}

/** Turns a Tether WDK EVM account into the signer ExactEvmScheme takes; refuses to sign when WDK would sign another type than primaryType. */
export declare function wdkEvmSigner(account: WdkEvmAccount): Promise<WdkX402Signer>;

/** The struct types no other type refers to (the primary type a WDK/ethers signer picks needs to be the only one). */
export declare function rootTypes(types: Record<string, readonly { name: string; type: string }[]>): string[];
