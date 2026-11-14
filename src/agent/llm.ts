import Anthropic from "@anthropic-ai/sdk";

// Provider-neutral chat + tool calling. The agent loop only talks to LlmClient, so switching
// between Anthropic and an OpenRouter model is configuration, not code.

export interface ToolDef { name: string; description: string; schema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; input: unknown }
export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface LlmResult { text: string; toolCalls: ToolCall[] }
export interface LlmClient {
  readonly label: string;
  complete(args: { system: string; messages: ChatMessage[]; tools?: ToolDef[]; maxTokens?: number }): Promise<LlmResult>;
}

export class AnthropicLlm implements LlmClient {
  private client: Anthropic;
  readonly label: string;
  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey });
    this.label = `anthropic:${model}`;
  }

  async complete({ system, messages, tools, maxTokens = 1500 }: Parameters<LlmClient["complete"]>[0]): Promise<LlmResult> {
    // Anthropic wants tool results as user-role blocks, and consecutive tool results in one message.
    const out: Anthropic.MessageParam[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        const last = out[out.length - 1];
        if (last?.role === "user" && Array.isArray(last.content)) (last.content as Anthropic.ContentBlockParam[]).push({ type: "text", text: m.content });
        else out.push({ role: "user", content: m.content });
      }
      else if (m.role === "assistant") {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input as Record<string, unknown> });
        out.push({ role: "assistant", content: blocks.length ? blocks : "(no text)" });
      } else {
        const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
        const last = out[out.length - 1];
        if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
          (last.content as Anthropic.ToolResultBlockParam[]).push(block);
        } else out.push({ role: "user", content: [block] });
      }
    }
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: out,
      ...(tools?.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as never })) } : {}),
    });
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    return { text: text.trim(), toolCalls };
  }
}

/** Any OpenAI-compatible chat completions endpoint; defaults to OpenRouter. */
export class OpenRouterLlm implements LlmClient {
  readonly label: string;
  constructor(
    private apiKey: string,
    private model: string,
    private baseUrl = "https://openrouter.ai/api/v1",
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.label = `openrouter:${model}`;
  }

  async complete({ system, messages, tools, maxTokens = 1500 }: Parameters<LlmClient["complete"]>[0]): Promise<LlmResult> {
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        ...messages.map((m) =>
          m.role === "tool"
            ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
            : m.role === "assistant"
              ? {
                  role: "assistant",
                  content: m.content || null,
                  ...(m.toolCalls?.length
                    ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
                    : {}),
                }
              : { role: "user", content: m.content }),
      ],
      ...(tools?.length
        ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })) }
        : {}),
    };
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Let'sGrow",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || json.error) {
      throw new Error(`OpenRouter ${res.status}: ${json.error?.message ?? res.statusText}`);
    }
    const msg = json.choices?.[0]?.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => {
      let input: unknown = {};
      try { input = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; }
      catch { input = { __unparseable: c.function?.arguments }; }
      return { id: c.id ?? `call_${i}`, name: c.function?.name ?? "", input };
    });
    const text = typeof msg.content === "string" ? msg.content : "";
    return { text: text.trim(), toolCalls };
  }
}

/** Server still boots without a key and says exactly what is missing. */
export class MissingKeyLlm implements LlmClient {
  readonly label = "none";
  async complete(): Promise<LlmResult> {
    throw new Error("No LLM configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in .env.");
  }
}

export function createLlm(env: {
  provider?: string; anthropicKey?: string; anthropicModel: string; openrouterKey?: string; openrouterModel: string;
}): LlmClient {
  const provider = env.provider || (env.anthropicKey ? "anthropic" : env.openrouterKey ? "openrouter" : "");
  if (provider === "anthropic" && env.anthropicKey) return new AnthropicLlm(env.anthropicKey, env.anthropicModel);
  if (provider === "openrouter" && env.openrouterKey) return new OpenRouterLlm(env.openrouterKey, env.openrouterModel);
  return new MissingKeyLlm();
}
