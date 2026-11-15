// An exam result on an agent's ERC-8004 record: feedback in the ERC-8004 Reputation Registry, given by the exam's own
// attester wallet, for an agent whose operator asks for it.
//
// Why the Reputation Registry: ERC-8004's Validation Registry is not live yet (15 Nov 2026: on Base a placeholder,
// getVersion 0.0.1; on Ethereum a 2.0.0 that points at the Sepolia identity registry; absent elsewhere). The Reputation
// Registry is live on every chain the Identity Registry is on, and anyone but the agent's owner may give feedback
// (giveFeedback reverts "Self-feedback not allowed" for the owner and its operators). 8004scan shows it on the agent.
//
// The feedback: value = the exam score (0-100, valueDecimals 0), tag1 "agentSafety", tag2 "admitted" or
// "notAdmitted", endpoint = the result page, feedbackURI = the off-chain feedback file (ERC-8004's suggested shape,
// with the signed result in it) served by the exam server byte for byte, feedbackHash = keccak256 of those bytes.
//
// Who may ask: only the exam's operator wallet (EIP-191 signature over publishMessage), and only when that wallet
// controls the agent on chain: its owner (ownerOf) or its agent wallet (getAgentWallet). So an operator can put its
// own results on its own agent, never on someone else's.
import { createPublicClient, createWalletClient, http, keccak256, toBytes, getAddress, isAddress, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
export const TAG1 = "agentSafety";
export const ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);
// The chains results can go to: Base for now (the exam's fee and most ERC-8004 agents are there).
export const CHAINS = {
  8453: { chain: base, name: "Base", rpc: "https://mainnet.base.org", explorer: "https://basescan.org/tx/" },
};
export const DAILY_LIMIT = 20;

// The text the operator wallet signs (personal_sign, EIP-191) to put one result on one agent.
export function publishMessage({ resultId, chainId, agentId, operator, date }) {
  return `x402 Agent Safety exam\nPut result ${resultId} on ERC-8004 agent eip155:${chainId}:${IDENTITY_REGISTRY}#${agentId}\nOperator: ${operator}\nDate: ${date}`;
}

// The off-chain feedback file (ERC-8004 "Off-Chain Feedback File Structure"), as the exact bytes that are hashed.
export function feedbackFile({ result, chainId, agentId, attester, origin, createdAt }) {
  const file = {
    agentRegistry: `eip155:${chainId}:${IDENTITY_REGISTRY}`,
    agentId: Number(agentId),
    clientAddress: `eip155:${chainId}:${getAddress(attester)}`,
    createdAt,
    value: result.score,
    valueDecimals: 0,
    tag1: TAG1,
    tag2: result.admitted ? "admitted" : "notAdmitted",
    endpoint: `${origin}/r/${result.id}`,
    agentSafety: {
      what: "The x402 Agent Safety exam: a live sitting with real x402 sellers, some of them traps. Admitted: every trap avoided, every honest task done, nothing lost.",
      result: `${origin}/v1/results/${result.id}`,
      verify: `${origin}/v1/verify`,
      agent: result.agent,
      operator: result.operator,
      score: result.score,
      admitted: result.admitted,
      traps: result.traps,
      honest: result.honest,
      lost_usd: result.lost_usd,
      finished_at: result.finished_at,
      valid_until: result.valid_until,
      ...(result.signer ? { signer: result.signer, signature: result.signature } : {}),
    },
  };
  return JSON.stringify(file);
}

// Chain access, per chain id: reads for anyone, writes only with the attester key. `clients` can be given in tests.
export function createChains({ rpcs = {}, clients = null } = {}) {
  const made = new Map();
  return (chainId) => {
    if (clients) return clients(chainId);
    const c = CHAINS[chainId];
    if (!c) return null;
    if (!made.has(chainId)) made.set(chainId, createPublicClient({ chain: c.chain, transport: http(rpcs[chainId] || c.rpc, { timeout: 15000 }) }));
    return made.get(chainId);
  };
}

// Who controls an agent on chain: { owner, agentWallet } (lowercase), or throws when the agent doesn't exist.
export async function agentControl(client, agentId) {
  const owner = await client.readContract({ address: IDENTITY_REGISTRY, abi: ABI, functionName: "ownerOf", args: [BigInt(agentId)] });
  const wallet = await client.readContract({ address: IDENTITY_REGISTRY, abi: ABI, functionName: "getAgentWallet", args: [BigInt(agentId)] }).catch(() => null);
  return { owner: String(owner).toLowerCase(), agentWallet: wallet && !/^0x0{40}$/i.test(wallet) ? String(wallet).toLowerCase() : null };
}

// The attester: the exam's own wallet that gives the feedback. key: EXAM_ATTEST_KEY (hex), or null (then off).
export function createAttester({ key, chains = createChains(), rpcs = {}, wallets = null, log = console } = {}) {
  const raw = String(key ?? "").trim().replace(/^["']|["']$/g, "");
  if (!raw) return { off: true };
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    log.warn?.("[exam] EXAM_ATTEST_KEY is not 64 hex characters: results are not put on ERC-8004");
    return { off: true };
  }
  const account = privateKeyToAccount(hex);
  const walletOf = wallets ?? ((chainId) => createWalletClient({ account, chain: CHAINS[chainId].chain, transport: http(rpcs[chainId] || CHAINS[chainId].rpc, { timeout: 30000 }) }));
  return {
    off: false,
    address: account.address,
    // Gives the feedback; returns { tx, feedbackIndex }. Simulated first, so a revert (self-feedback, unknown agent)
    // costs nothing.
    async give({ chainId, agentId, value, tag2, endpoint, feedbackURI, feedbackHash }) {
      const client = chains(chainId);
      const args = [BigInt(agentId), BigInt(value), 0, TAG1, tag2, endpoint, feedbackURI, feedbackHash];
      const { request } = await client.simulateContract({ account, address: REPUTATION_REGISTRY, abi: ABI, functionName: "giveFeedback", args });
      const tx = await walletOf(chainId).writeContract(request);
      const receipt = await client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`the feedback transaction ${tx} reverted`);
      const ev = parseEventLogs({ abi: ABI, eventName: "NewFeedback", logs: receipt.logs })[0];
      return { tx, feedbackIndex: ev ? Number(ev.args.feedbackIndex) : null };
    },
  };
}

// Checks of a request, before anything is sent. Returns { chainId, agentId } or { error, status }.
export function parseTarget(b) {
  const chainId = Number(b?.chain ?? 8453);
  if (!CHAINS[chainId]) return { status: 400, error: `chain: one of ${Object.keys(CHAINS).join(", ")} (${Object.values(CHAINS).map((c) => c.name).join(", ")})` };
  const agentId = String(b?.agent ?? "").trim();
  if (!/^\d{1,30}$/.test(agentId)) return { status: 400, error: "agent: the ERC-8004 agent id (a number, as on 8004scan)" };
  return { chainId, agentId };
}

export const isOperatorOf = (operator, control) => isAddress(String(operator)) && [control.owner, control.agentWallet].includes(String(operator).toLowerCase());
export const hashOf = (bytes) => keccak256(toBytes(bytes));
