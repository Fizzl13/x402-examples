// The exam's MCP server: POST /mcp, streamable HTTP, stateless, JSON answers. Free tools only, so any MCP client (and
// MCP directories such as Glama and the official registry) can ask whether an agent is admitted, read the index, see
// how to take the exam, or start a demo to watch. Hand-rolled JSON-RPC: four tools don't need the SDK.
//
//   agent_safety_check      is this agent admitted? its latest signed result, by name (or result id)
//   agent_safety_index      the index: every agent's latest result
//   agent_safety_exam_howto how to enter an agent: the steps, and the message its operator wallet signs
//   agent_safety_demo       start a demo sitting and get the link to watch it live

export const MCP_VERSION = "1.0.0";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const TOOLS = [
  {
    name: "agent_safety_check",
    title: "Is this AI agent admitted?",
    description:
      "Look up an AI agent in the Agent Safety Index: did it pass the x402 Agent Safety exam (paying honest x402 sellers, refusing cheating ones: overcharges, sanctioned payees, injected instructions, pay-again loops, look-alike payout addresses)? Returns its latest signed result: score, traps avoided, honest tasks done, money lost, whether its admission is current, and links to the signed result and a replay. Free.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The agent's name as it was entered (case-insensitive; a part of the name works too)" },
        result_id: { type: "string", description: "Or a result id (24 hex characters) from a badge or result link" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "agent_safety_index",
    title: "The Agent Safety Index",
    description: "Every agent's latest result in the Agent Safety Index (admitted ones first): score, traps avoided, honest tasks done, money lost, admitted or not, valid until. Free.",
    inputSchema: { type: "object", properties: { admitted_only: { type: "boolean", description: "Only agents whose admission is current" } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "agent_safety_exam_howto",
    title: "How to enter an agent for the exam",
    description:
      "How to have an AI agent take the x402 Agent Safety exam: 19 tasks at simulated x402 sellers on Base Sepolia (test money, nothing settled), 30 minutes. The first exam per operator wallet is free; every next one is $0.10 over x402. Given the agent and the operator wallet, also returns the exact message the operator wallet signs for the free exam. Free.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The agent's name" },
        version: { type: "string", description: "Its version (default 1)" },
        operator: { type: "string", description: "The operator's wallet address (0x…), which answers for the agent" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "agent_safety_demo",
    title: "Watch an agent take the exam",
    description:
      "Start a demo: a scripted agent takes the x402 Agent Safety exam slowly enough to follow, and you get a link to watch it live (every request, every 402, every x402 Doctor check, every signed payment). `follow-preflight` pays only when x402 Doctor's preflight says go; `always-pay` pays every 402. Demos are not stored. Free.",
    inputSchema: { type: "object", properties: { agent: { type: "string", enum: ["follow-preflight", "always-pay"], description: "Which scripted agent (default follow-preflight)" } } },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
];

const INSTRUCTIONS =
  "The Agent Safety Index (exam.fizzl.eu) lists AI agents that passed the x402 Agent Safety exam. Use agent_safety_check before trusting an agent with a wallet or a payment; agent_safety_index for the whole list; agent_safety_exam_howto to enter an agent; agent_safety_demo to watch one take the exam.";

// handlers: { check({agent, result_id}), index({admitted_only}), howto({agent, version, operator}), demo({agent}, req) }
// Each returns a plain object (the structured result) or throws an Error whose message goes back as a tool error.
export function createMcpHandler({ handlers, name = "agent-safety-exam", onCall = () => {} }) {
  const byName = { agent_safety_check: handlers.check, agent_safety_index: handlers.index, agent_safety_exam_howto: handlers.howto, agent_safety_demo: handlers.demo };

  async function one(msg, req) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "invalid request" } };
    const isNote = msg.id === undefined || msg.id === null;
    const reply = (result) => (isNote ? null : { jsonrpc: "2.0", id: msg.id, result });
    const fail = (code, message) => (isNote ? null : { jsonrpc: "2.0", id: msg.id, error: { code, message } });
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        return reply({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name, title: "Agent Safety Index", version: MCP_VERSION, websiteUrl: "https://exam.fizzl.eu" }, instructions: INSTRUCTIONS });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const fn = byName[msg.params?.name];
        if (!fn) return fail(-32602, `unknown tool: ${msg.params?.name}`);
        try {
          const out = await fn(msg.params?.arguments || {}, req);
          onCall(msg.params.name, req, true);
          return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false });
        } catch (err) {
          onCall(msg.params.name, req, false);
          return reply({ content: [{ type: "text", text: err.message }], isError: true });
        }
      }
      case "resources/list":
        return reply({ resources: [] });
      case "prompts/list":
        return reply({ prompts: [] });
      default:
        if (msg.method.startsWith("notifications/")) return null;
        return fail(-32601, `method not found: ${msg.method}`);
    }
  }

  return async function mcp(req, res) {
    const body = req.body;
    const batch = Array.isArray(body);
    const answers = (await Promise.all((batch ? body : [body]).map((m) => one(m, req)))).filter(Boolean);
    res.set("access-control-allow-origin", "*");
    if (!answers.length) return res.status(202).end();
    res.json(batch ? answers : answers[0]);
  };
}

// The server card (SEP-1649) for MCP directories.
export function serverCard() {
  return {
    serverInfo: { name: "agent-safety-exam", title: "Agent Safety Index", version: MCP_VERSION },
    transport: { type: "streamable-http", endpoint: "/mcp" },
    capabilities: { tools: { listChanged: false } },
    authentication: { required: false },
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    resources: [],
    prompts: [],
  };
}
