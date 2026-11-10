// The chain reads and writes the facilitator needs (src/scheme.js), over a Concordium node's gRPC API.
import { AccountAddress, TransactionHash, TransactionKindString } from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { CborAccountAddress, Token, TokenAmount, TokenId } from '@concordium/web-sdk/plt';

// A node (or the proxy in front of it) that is briefly unavailable answers gRPC UNAVAILABLE, e.g. "Received HTTP
// status code 502" (the daily testnet check failed that way on 9 Nov 2026). Reads and the wait for finalization are
// asked once more after a short pause; sending a transaction never is, so nothing is submitted twice.
export function isTransient(err) {
  const text = String(err?.message ?? err ?? '');
  return err?.code === 14 || /UNAVAILABLE|Received HTTP status code 50[234]|ECONNRESET|socket hang up/i.test(text);
}
export async function retryTransient(fn, { pauseMs = 1500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!isTransient(err)) throw err;
    await sleep(pauseMs);
    return fn();
  }
}

export function createNode({ host = 'grpc.testnet.concordium.com', port = 20000, timeoutMs = 15_000, finalizeMs = 60_000 } = {}) {
  const grpc = new ConcordiumGRPCNodeClient(host, Number(port), credentials.createSsl(), { timeout: timeoutMs });
  const again = retryTransient;
  const addr = (a) => AccountAddress.fromBase58(a);
  const tokens = new Map(); // id -> Token (its module state is refreshed by validateTransfer)
  async function tokenOf(id) {
    if (!tokens.has(id)) tokens.set(id, await again(() => Token.fromId(grpc, TokenId.fromString(id))));
    return tokens.get(id);
  }
  return {
    grpc,
    identityProviders() { return grpc.getIdentityProviders(); },
    async accountInfo(a) { try { return await again(() => grpc.getAccountInfo(addr(a))); } catch { return null; } },
    async nextNonce(a) { return (await again(() => grpc.getNextAccountNonce(addr(a)))).nonce.value; },
    async balance(a, asset) {
      const info = await again(() => grpc.getAccountInfo(addr(a)));
      if (asset === 'CCD') return BigInt(info.accountAvailableBalance.microCcdAmount);
      const t = info.accountTokens.find((x) => x.id.value === asset);
      return t ? BigInt(t.state.balance.value) : 0n;
    },
    async token(id) {
      try {
        const t = await tokenOf(id);
        return { decimals: t.info.state.decimals, paused: Boolean(t.moduleState?.paused) };
      } catch { return null; }
    },
    async checkTransfer(id, from, to, amount, decimals) {
      try {
        const t = await tokenOf(id);
        await Token.validateTransfer(t, addr(from), [{ amount: TokenAmount.create(BigInt(amount), decimals), recipient: CborAccountAddress.fromAccountAddress(addr(to)) }]);
        return null;
      } catch (err) { return err?.message || 'refused'; }
    },
    async send(finalized) { return TransactionHash.toHexString(await grpc.sendTransaction(finalized)); },
    async waitFinal(hash) {
      const r = await again(() => grpc.waitForTransactionFinalization(TransactionHash.fromHexString(hash), finalizeMs));
      const s = r.summary;
      if (s?.type !== 'accountTransaction') return { success: false, reason: 'not an account transaction' };
      if (s.transactionType === TransactionKindString.Failed) return { success: false, reason: s.rejectReason?.tag ?? 'rejected' };
      return { success: true, block: r.blockHash ? String(r.blockHash) : null };
    },
  };
}
