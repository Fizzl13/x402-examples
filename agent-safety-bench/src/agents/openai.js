// An agent behind any API that speaks OpenAI's Chat Completions format: OpenAI itself, or OpenRouter, which serves
// GPT, Gemini, Llama and other vendors' models with one key. The same tools and the same plain tool-use loop as the
// Claude agent, so other model families run the same scenarios. The model id comes from the caller (--model), as the
// endpoint names it (for OpenRouter "<vendor>/<model>").

export const ENDPOINTS = {
  openai: { baseURL: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
};

// The tools as functions. additionalProperties is left out: not every vendor behind OpenRouter accepts it, and it only
// says that header values are strings.
const plain = (schema) => JSON.parse(JSON.stringify(schema, (k, v) => (k === "additionalProperties" ? undefined : v)));
const asFunction = (t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: plain(t.input_schema) } });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function openaiAgent({ model, endpoint = "openai", maxTurns = 20, apiKey, baseURL, fetch: doFetch = globalThis.fetch, retries = 4, sleep = wait }) {
  if (!model) throw new Error(`--model is required for the ${endpoint} agent (a model id as the endpoint names it)`);
  const { baseURL: defaultURL, keyEnv } = ENDPOINTS[endpoint] ?? ENDPOINTS.openai;
  const url = `${(baseURL ?? process.env.OPENAI_BASE_URL ?? defaultURL).replace(/\/+$/, "")}/chat/completions`;
  const key = apiKey ?? process.env[keyEnv];

  async function complete(body) {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (res.ok && json && !json.error) return json;
      const message = json?.error?.message || text.slice(0, 300) || "no body";
      // Rate limits and server errors are retried with backoff; anything else (a bad key, no credit) is final.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${message}`);
    }
  }

  return {
    name: `${endpoint}:${model}`,
    async run({ system, task, tools }) {
      const messages = [{ role: "system", content: system }, { role: "user", content: task }];
      const definitions = tools.definitions.map(asFunction);
      // The report sums these four, as the Claude agent reports them; cached prompt tokens count as cache reads.
      const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const transcript = [];
      let answer = "";
      let turns = 0;
      let stop = null;
      let ended = false;

      while (turns < maxTurns) {
        turns += 1;
        const response = await complete({ model, messages, tools: definitions });
        const u = response.usage ?? {};
        const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
        usage.input_tokens += (u.prompt_tokens ?? 0) - cached;
        usage.cache_read_input_tokens += cached;
        usage.output_tokens += u.completion_tokens ?? 0;

        const choice = response.choices?.[0];
        const message = choice?.message ?? {};
        const calls = message.tool_calls ?? [];
        // Back into the conversation as the endpoint sent it, with the reasoning some models need to continue a tool
        // call (OpenRouter's reasoning_details).
        messages.push({ role: "assistant", content: message.content ?? null, ...(calls.length ? { tool_calls: calls } : {}), ...(message.reasoning_details ? { reasoning_details: message.reasoning_details } : {}) });
        const text = String(message.content ?? "").trim();
        if (text) answer = text;
        stop = choice?.finish_reason ?? null;

        if (calls.length === 0) {
          transcript.push({ turn: turns, text, stop });
          ended = true;
          break;
        }
        for (const call of calls) {
          let input = null;
          try {
            input = JSON.parse(call.function?.arguments || "{}");
          } catch {
            input = null;
          }
          const result = input ? await tools.run(call.function.name, input) : { error: "the arguments are not valid JSON" };
          transcript.push({ turn: turns, tool: call.function?.name, input: input ?? call.function?.arguments, result });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }

      if (!ended) stop = "max_turns";
      return { answer, turns, usage, stop, transcript };
    },
  };
}
