// Tether WDK accounts as x402 signers (16 Nov 2026).
//
// Tether's Wallet Development Kit (docs.wdk.tether.io) keeps a self-custodial account in the agent's own app, one
// module per chain. Its EVM account (@tetherto/wdk-wallet-evm, WalletAccountEvm) signs EIP-712 typed data with
// signTypedData({ domain, types, message }), which is what an x402 "exact" payment on an EVM chain needs. wdkEvmSigner
// turns such an account into the signer @x402/evm's ExactEvmScheme takes, so a WDK wallet pays through
// createSafeFetch: the endpoint is checked first (Doctor preflight, budget, sites, payees) and WDK signs only then.
//
// Two differences between WDK and viem that the adapter covers:
// - WDK's address comes from an async getAddress(); x402 reads signer.address directly, so the adapter is async and
//   reads it once.
// - WDK signs with ethers, which works out the primary type itself and refuses an EIP712Domain entry in `types`. The
//   adapter drops EIP712Domain and checks that the type ethers will sign is the primaryType x402 asked for, so a
//   different struct is never signed by accident.
// Checked on 16 Nov 2026 with @tetherto/wdk-wallet-evm 1.0.0-beta.26: for the same key and an x402 EIP-3009
// TransferWithAuthorization, WDK's signature is byte-for-byte viem's.

/** The struct types no other type refers to: what ethers picks as the primary type (it needs exactly one). */
export function rootTypes(types) {
  const names = Object.keys(types);
  const used = new Set();
  for (const fields of Object.values(types)) {
    for (const f of fields ?? []) used.add(String(f?.type ?? "").replace(/\[\d*\]/g, ""));
  }
  return names.filter((n) => !used.has(n));
}

/**
 * An x402 EVM signer from a Tether WDK EVM account (WalletAccountEvm, or anything with getAddress() and
 * signTypedData({ domain, types, message })). Use it where you would pass a viem account:
 *   const signer = await wdkEvmSigner(account);
 *   register: (client) => client.register("eip155:8453", new ExactEvmScheme(signer))
 */
export async function wdkEvmSigner(account) {
  if (!account || typeof account.getAddress !== "function" || typeof account.signTypedData !== "function") {
    throw new TypeError("wdkEvmSigner needs a Tether WDK EVM account (getAddress() and signTypedData({ domain, types, message }))");
  }
  const address = String(await account.getAddress());
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new TypeError(`the WDK account gave no EVM address (${address.slice(0, 60)})`);
  return {
    address,
    async signTypedData({ domain, types, primaryType, message }) {
      const { EIP712Domain: _domainType, ...structs } = types ?? {};
      const roots = rootTypes(structs);
      if (roots.length !== 1 || roots[0] !== primaryType) {
        throw new Error(`WDK signs the one top-level type in "types" (${roots.join(", ") || "none"}), not the requested ${primaryType}: refusing to sign`);
      }
      const signature = await account.signTypedData({ domain, types: structs, message });
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new Error("the WDK account returned no signature");
      return signature;
    },
  };
}
