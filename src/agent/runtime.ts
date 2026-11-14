import { z } from "zod";
import type { ChatMessage, LlmClient, ToolDef } from "./llm.js";

// A small, standard agent loop: the model calls tools until it has what it needs, then answers.
// Tool inputs are validated with zod; validation and runtime errors go back to the model so it
// can correct itself instead of the code guessing.

export interface Tool {
  name: string;
  description: string;
  input: z.ZodType;
  run(input: any): Promise<unknown> | unknown;
}

export function toolDef(t: Tool): ToolDef {
  const schema = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, description: t.description, schema };
}

export interface AgentRun {
  text: string;
  calls: { name: string; input: unknown; ok: boolean; result: unknown }[];
}

export async function runAgent(args: {
  llm: LlmClient;
  system: string;
  input: string;
  tools: Tool[];
  maxSteps?: number;
}): Promise<AgentRun> {
  const { llm, system, tools } = args;
  const defs = tools.map(toolDef);
  const messages: ChatMessage[] = [{ role: "user", content: args.input }];
  const calls: AgentRun["calls"] = [];
  const maxSteps = args.maxSteps ?? 8;

  for (let step = 0; step < maxSteps; step++) {
    const out = await llm.complete({ system, messages, tools: defs });
    if (out.toolCalls.length === 0) return { text: out.text, calls };
    messages.push({ role: "assistant", content: out.text, toolCalls: out.toolCalls });
    for (const call of out.toolCalls) {
      const tool = tools.find((t) => t.name === call.name);
      let result: unknown;
      let ok = false;
      if (!tool) result = { error: `Unknown tool ${call.name}. Available: ${tools.map((t) => t.name).join(", ")}` };
      else {
        const parsed = tool.input.safeParse(call.input ?? {});
        if (!parsed.success) {
          result = { error: "Invalid input", issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
        } else {
          try { result = await tool.run(parsed.data); ok = !(result && typeof result === "object" && "error" in result); }
          catch (err) { result = { error: (err as Error).message }; }
        }
      }
      calls.push({ name: call.name, input: call.input, ok, result });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(result ?? null) });
    }
  }
  // Out of steps: ask for a final answer without tools.
  const final = await llm.complete({ system, messages: [...messages, { role: "user", content: "(Reply to the person now, without calling tools.)" }], tools: defs });
  return { text: final.text, calls };
}
