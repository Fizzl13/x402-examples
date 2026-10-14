// A Claude agent: the Messages API with the two tools, in a plain tool-use loop. The model id comes from the caller
// (--model), so the bench names no model of its own. Prompt caching: a breakpoint on the system prompt (shared by every
// run of a condition) plus automatic caching for the growing conversation.

import Anthropic from "@anthropic-ai/sdk";

export function claudeAgent({ model, maxTurns = 20, maxTokens = 8000, thinking = "adaptive", caching = true, client = new Anthropic({ maxRetries: 4 }) }) {
  if (!model) throw new Error("--model is required for the claude agent (a Claude model id)");
  return {
    name: `claude:${model}${thinking === "off" ? ":no-thinking" : ""}`,
    async run({ system, task, tools }) {
      const messages = [{ role: "user", content: task }];
      const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const transcript = [];
      let answer = "";
      let turns = 0;
      let stop = null;

      while (turns < maxTurns) {
        turns += 1;
        const response = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system: [{ type: "text", text: system, ...(caching ? { cache_control: { type: "ephemeral" } } : {}) }],
          tools: tools.definitions,
          messages,
          ...(caching ? { cache_control: { type: "ephemeral" } } : {}),
          ...(thinking === "adaptive" ? { thinking: { type: "adaptive" } } : {}),
        });
        for (const k of Object.keys(usage)) usage[k] += response.usage?.[k] ?? 0;
        messages.push({ role: "assistant", content: response.content });
        const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (text) answer = text;
        stop = response.stop_reason;

        const calls = response.content.filter((b) => b.type === "tool_use");
        if (stop !== "tool_use" || calls.length === 0) {
          transcript.push({ turn: turns, text, stop });
          break;
        }

        const results = [];
        for (const call of calls) {
          const result = await tools.run(call.name, call.input);
          transcript.push({ turn: turns, tool: call.name, input: call.input, result });
          results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) });
        }
        messages.push({ role: "user", content: results });
      }

      if (stop === "tool_use") stop = "max_turns";
      return { answer, turns, usage, stop, transcript };
    },
  };
}
