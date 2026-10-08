// Try the tools without a wallet: with no payment set up they answer with the free quick check.
// In an agent: createReactAgent({ llm, tools: fizzlTools() }) from @langchain/langgraph/prebuilt,
// or createAgent({ model, tools: fizzlTools() }) from "langchain".
import { fizzlTools } from "../index.js";

const tools = Object.fromEntries(fizzlTools().map((t) => [t.name, t]));
console.log("check_token (USDC on Base):", await tools.check_token.invoke({ chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }));
console.log("check_endpoint_before_paying:", await tools.check_endpoint_before_paying.invoke({ url: "https://presign-guard.fizzl.eu/v1/token?chain=base&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }));
