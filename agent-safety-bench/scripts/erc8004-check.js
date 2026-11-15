// Read-only check of src/exam/erc8004.js against the real ERC-8004 registries on Base: who controls an agent, and a
// simulated giveFeedback (eth_call, nothing sent) from an address that isn't the agent's.
//   node scripts/erc8004-check.js [agentId]   (default 988891)
import { createPublicClient, http } from "viem";
import { ABI, CHAINS, REPUTATION_REGISTRY, TAG1, agentControl } from "../src/exam/erc8004.js";

const agentId = process.argv[2] || "988891";
const client = createPublicClient({ chain: CHAINS[8453].chain, transport: http(process.env.BASE_RPC_URL || CHAINS[8453].rpc) });
const control = await agentControl(client, agentId);
console.log(`agent ${agentId} on Base: owner ${control.owner}, agent wallet ${control.agentWallet ?? "(none)"}`);
const someone = "0x000000000000000000000000000000000000dEaD";
await client.simulateContract({ account: someone, address: REPUTATION_REGISTRY, abi: ABI, functionName: "giveFeedback", args: [BigInt(agentId), 90n, 0, TAG1, "admitted", "https://exam.fizzl.eu/r/x", "https://exam.fizzl.eu/v1/results/x/erc8004/8453/1.json", `0x${"00".repeat(32)}`] });
console.log("giveFeedback simulates fine from another address");
try {
  await client.simulateContract({ account: control.owner, address: REPUTATION_REGISTRY, abi: ABI, functionName: "giveFeedback", args: [BigInt(agentId), 90n, 0, TAG1, "admitted", "", "", `0x${"00".repeat(32)}`] });
  console.log("UNEXPECTED: the owner may give itself feedback");
} catch (err) {
  console.log(`from the owner it reverts, as it should: ${err.shortMessage?.split("\n")[0]}`);
}
