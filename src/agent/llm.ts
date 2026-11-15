import Anthropic from "@anthropic-ai/sdk";

// Provider-neutral chat + tool calling. The agent loop only talks to LlmClient: Claude runs the
// agents (with its built-in web search); Gemini is an alternative when no Claude key is set.

export interface ToolDef { name: string; description: string; schema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; input: unknown }
export interface ImagePart { mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string /* base64 */ }
export type ChatMessage =
  | { role: "user"; content: string; images?: ImagePart[] }
  /** `raw`: the provider's own content blocks, replayed as-is (needed for server-side tools like web search). */
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; raw?: unknown }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface LlmResult { text: string; toolCalls: ToolCall[]; raw?: unknown; webSearches?: number; sources?: { title: string; url: string }[] }
export interface LlmClient {
  readonly label: string;
  /** Whether `webSearch: true` works with this model (Claude's built-in search). */
  readonly canSearchWeb?: boolean;
  /**
   * webSearch: opt-in, per call. Only the web researcher turns it on: a search query is a way for text
   * to leave the system, so agents that hold private data or read other people's text never get it.
   */
  complete(args: { system: string; messages: ChatMessage[]; tools?: ToolDef[]; maxTokens?: number; webSearch?: boolean }): Promise<LlmResult>;
}

export class AnthropicLlm implements LlmClient {
  private client: Anthropic;
  readonly label: string;
  /**
   * webSearchMaxUses > 0 makes Claude's built-in web search available (run by Anthropic, billed per
   * search) to calls that ask for it with webSearch: true.
   */
  constructor(apiKey: string, private model: string, private webSearchMaxUses = 0) {
    this.client = new Anthropic({ apiKey });
    this.label = `anthropic:${model}${webSearchMaxUses ? "+web_search" : ""}`;
    this.canSearchWeb = webSearchMaxUses > 0;
  }
  readonly canSearchWeb: boolean;

  async complete({ system, messages, tools, maxTokens = 1500, webSearch = false }: Parameters<LlmClient["complete"]>[0]): Promise<LlmResult> {
    // Anthropic wants tool results as user-role blocks, and consecutive tool results in one message.
    const out: Anthropic.MessageParam[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        const blocks: Anthropic.ContentBlockParam[] = [
          ...(m.images ?? []).map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } })),
          { type: "text", text: m.content },
        ];
        const last = out[out.length - 1];
        if (last?.role === "user" && Array.isArray(last.content)) (last.content as Anthropic.ContentBlockParam[]).push(...blocks);
        else out.push({ role: "user", content: m.images?.length ? blocks : m.content });
      }
      else if (m.role === "assistant" && isAnthropicRaw(m.raw)) out.push({ role: "assistant", content: m.raw as Anthropic.ContentBlockParam[] });
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
    const toolList: Anthropic.ToolUnion[] = (tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as never }));
    if (webSearch && this.webSearchMaxUses > 0) toolList.push({ type: "web_search_20250305", name: "web_search", max_uses: this.webSearchMaxUses });

    // Server tools can pause a long turn; continue it by sending the partial turn back.
    const blocks: Anthropic.ContentBlock[] = [];
    let res: Anthropic.Message;
    for (let i = 0; ; i++) {
      const msgs: Anthropic.MessageParam[] = blocks.length ? [...out, { role: "assistant", content: blocks as Anthropic.ContentBlockParam[] }] : out;
      res = await this.client.messages.create({ model: this.model, max_tokens: maxTokens, system, messages: msgs, ...(toolList.length ? { tools: toolList } : {}) });
      blocks.push(...res.content);
      if (res.stop_reason !== "pause_turn" || i >= 3) break;
    }
    let text = "";
    let webSearches = 0;
    const sources: { title: string; url: string }[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of blocks) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
      else if (block.type === "server_tool_use" && block.name === "web_search") webSearches++;
      else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) if (r.type === "web_search_result") sources.push({ title: r.title, url: r.url });
      }
    }
    return { text: text.trim(), toolCalls, raw: blocks, webSearches, sources };
  }
}

// A turn can switch models halfway (Gemini fails, Claude takes over), so each one only replays
// tool calls in its own format and rebuilds the rest from the neutral toolCalls.
const isOpenAiRaw = (raw: unknown): raw is unknown[] =>
  Array.isArray(raw) && raw.length > 0 && raw.every((b) => !!b && typeof b === "object" && "function" in b);
const isAnthropicRaw = (raw: unknown): raw is unknown[] =>
  Array.isArray(raw) && raw.length > 0 && !isOpenAiRaw(raw);

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

/** Gemini, through Google's OpenAI-compatible chat completions endpoint. */
export class GeminiLlm implements LlmClient {
  readonly label: string;
  constructor(
    private apiKey: string,
    private model: string,
    private fetchImpl: typeof fetch = fetch,
    private baseUrl = GEMINI_BASE_URL,
    private retryMs = 1500,
  ) {
    this.label = `gemini:${model}`;
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
                  // Replay the provider's own tool calls when we have them: Gemini attaches thought
                  // signatures there and rejects a follow-up turn without them.
                  ...(isOpenAiRaw(m.raw)
                    ? { tool_calls: m.raw }
                    : m.toolCalls?.length
                      ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
                      : {}),
                }
              : m.images?.length
                ? { role: "user", content: [{ type: "text", text: m.content }, ...m.images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mediaType};base64,${im.data}` } }))] }
                : { role: "user", content: m.content }),
      ],
      ...(tools?.length
        ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })) }
        : {}),
    };
    const send = () => this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    let res = await send();
    // "High demand" spikes are short: one quick retry before the backup takes over.
    if (res.status === 503 || res.status === 429) { await new Promise((r) => setTimeout(r, this.retryMs)); res = await send(); }
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || json.error) {
      throw new Error(`Gemini ${res.status}: ${json.error?.message ?? (Array.isArray(json) ? json[0]?.error?.message : undefined) ?? res.statusText}`);
    }
    const msg = json.choices?.[0]?.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => {
      let input: unknown = {};
      try { input = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; }
      catch { input = { __unparseable: c.function?.arguments }; }
      return { id: c.id ?? `call_${i}`, name: c.function?.name ?? "", input };
    });
    const text = typeof msg.content === "string" ? msg.content : "";
    return { text: text.trim(), toolCalls, ...(msg.tool_calls?.length ? { raw: msg.tool_calls } : {}) };
  }
}

/**
 * Gemini first, Claude if Gemini errors. A call that needs web search goes straight to whichever
 * model has it (Claude's built-in search).
 */
export class FallbackLlm implements LlmClient {
  readonly label: string;
  readonly canSearchWeb?: boolean;
  constructor(private first: LlmClient, private second: LlmClient) {
    this.label = `${first.label} (backup ${second.label})`;
    this.canSearchWeb = !!(first.canSearchWeb || second.canSearchWeb);
  }
  async complete(args: Parameters<LlmClient["complete"]>[0]): Promise<LlmResult> {
    if (args.webSearch && !this.first.canSearchWeb && this.second.canSearchWeb) return this.second.complete(args);
    // Once the backup has made a tool call in this turn, it finishes the turn: Gemini rejects
    // tool calls it didn't make itself (no thought signature).
    const backupTookOver = args.messages.some((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0 && !isOpenAiRaw(m.raw));
    if (backupTookOver && this.first.label.startsWith("gemini")) return this.second.complete(args);
    try { return await this.first.complete(args); }
    catch (err) {
      console.warn(`${this.first.label} failed, using ${this.second.label}:`, (err as Error).message);
      return this.second.complete(args);
    }
  }
}

/** Server still boots without a key and says exactly what is missing. */
export class MissingKeyLlm implements LlmClient {
  readonly label = "none";
  async complete(): Promise<LlmResult> {
    throw new Error("No LLM configured. Set GEMINI_API_KEY (and ANTHROPIC_API_KEY as backup) in .env.");
  }
}

type LlmEnv = { geminiKey?: string; geminiModel: string; anthropicKey?: string; anthropicModel: string; webSearchMaxUses?: number };

/** Claude runs everything. Gemini is only used if there's no Claude key. */
export function createLlm(env: LlmEnv): LlmClient {
  if (env.anthropicKey) return new AnthropicLlm(env.anthropicKey, env.anthropicModel, env.webSearchMaxUses ?? 0);
  if (env.geminiKey) return new GeminiLlm(env.geminiKey, env.geminiModel);
  return new MissingKeyLlm();
}
