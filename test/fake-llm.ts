import type { ChatMessage, LlmClient, LlmResult, ToolDef } from "../src/agent/llm.js";

export interface LlmCall { system: string; messages: ChatMessage[]; tools?: ToolDef[] }

/**
 * Test double for the model: each call is answered by `respond`, which sees exactly what a real
 * model would (system prompt, messages including tool results, tool list). Tests script the
 * model's decisions; the code under test is everything around it.
 */
export class ScriptedLlm implements LlmClient {
  readonly label = "scripted";
  readonly calls: LlmCall[] = [];
  private n = 0;
  constructor(private respond: (call: LlmCall, i: number) => LlmResult | Promise<LlmResult>) {}
  async complete(args: LlmCall): Promise<LlmResult> {
    this.calls.push(structuredClone(args));
    return this.respond(args, this.n++);
  }
}

/** Steps for one agent run: tool calls first, then the final text. */
export function steps(...s: (LlmResult | string)[]) {
  return (_: LlmCall, i: number): LlmResult => {
    const x = s[Math.min(i, s.length - 1)];
    return typeof x === "string" ? { text: x, toolCalls: [] } : x;
  };
}

export const call = (name: string, input: unknown = {}, id = `${name}_${Math.random().toString(36).slice(2, 7)}`): LlmResult =>
  ({ text: "", toolCalls: [{ id, name, input }] });

/** The last tool result the model was shown, parsed. */
export function lastToolResult(c: LlmCall): any {
  const t = [...c.messages].reverse().find((m) => m.role === "tool");
  return t && t.role === "tool" ? JSON.parse(t.content) : undefined;
}
