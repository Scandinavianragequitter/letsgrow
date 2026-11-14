import Anthropic from "@anthropic-ai/sdk";

export interface ToolSpec { name: string; description: string; schema: Record<string, unknown> }
export interface LlmTurn { text: string; toolCalls: { name: string; input: unknown }[] }
export interface LlmClient {
  complete(args: {
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    tool: ToolSpec;
  }): Promise<LlmTurn>;
}

export class AnthropicLlm implements LlmClient {
  private client: Anthropic;
  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey });
  }
  async complete({ system, messages, tool }: Parameters<LlmClient["complete"]>[0]): Promise<LlmTurn> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1500,
      system,
      messages,
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema as never }],
    });
    let text = "";
    const toolCalls: LlmTurn["toolCalls"] = [];
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") toolCalls.push({ name: block.name, input: block.input });
    }
    return { text: text.trim(), toolCalls };
  }
}

/** Used when no API key is configured, so the server still boots and says what is missing. */
export class MissingKeyLlm implements LlmClient {
  async complete(): Promise<LlmTurn> {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env to enable the habit agent.");
  }
}

/**
 * Offline stand-in for the real model (LLM_MOCK=1): keyword rules that emit the same propose_plan call.
 * Only for trying the UI without an API key. The real planner is the Anthropic model above.
 */
export class RuleBasedLlm implements LlmClient {
  async complete({ messages }: Parameters<LlmClient["complete"]>[0]): Promise<LlmTurn> {
    const text = messages[messages.length - 1].content.toLowerCase();
    const hours = text.match(/(\d+(?:\.\d+)?)\s*(?:h|hour|hours)\b/);
    const mins = text.match(/(\d+)\s*(?:m|min|minutes)\b/);
    const limit = mins ? Number(mins[1]) : hours ? Number(hours[1]) * 60 : 60;

    if (/instagram|tiktok|youtube|twitter|scroll|screen/.test(text)) {
      const app = /tiktok/.test(text) ? "TikTok" : /youtube/.test(text) ? "YouTube" : /twitter/.test(text) ? "X" : "Instagram";
      return { text: `I'll check Screen Time for ${app} every evening, so there's nothing for you to do or report.`, toolCalls: [{ name: "propose_plan", input: {
        title: `Under ${limit} min of ${app} a day`, summary: `Automatic check of ${app} screen time each evening.`, mode: "autonomous",
        autonomous: { source: "screen_time", metric: `app_minutes:${app}`, comparator: "lte", threshold: limit, unit: "min", evaluateAt: "22:00" },
        suggestedMissedDaysBeforeFriendNudge: 1,
      } }] };
    }
    if (/stretch|mobility|warm.?up|cool.?down/.test(text)) {
      return { text: "I can see your calendar, so I'll remind you 10 minutes before and 5 minutes after each training. Just react with a heart (❤️) when you've done it.", toolCalls: [{ name: "propose_plan", input: {
        title: "Stretch around every training", summary: "Calendar-anchored reminders, one heart to confirm.", mode: "prompted",
        prompted: { reminders: [
          { anchor: "calendar_event", eventKeyword: "training", edge: "start", offsetMinutes: -10, text: "Training soon: stretch for 10 min first. React ❤️ when done." },
          { anchor: "calendar_event", eventKeyword: "training", edge: "end", offsetMinutes: 5, text: "Nice session. 5 min of stretching now. React ❤️ when done." },
        ], confirmWith: "heart", confirmWithinMinutes: 120 },
        suggestedMissedDaysBeforeFriendNudge: 2,
      } }] };
    }
    return { text: "I'll text you once a day at 20:00 and you reply with one heart when it's done.", toolCalls: [{ name: "propose_plan", input: {
      title: "Daily habit check-in", summary: "One evening reminder, one heart to confirm.", mode: "prompted",
      prompted: { reminders: [{ anchor: "fixed_time", time: "20:00", text: "Did you do it today? React ❤️ if yes." }], confirmWith: "heart", confirmWithinMinutes: 180 },
      suggestedMissedDaysBeforeFriendNudge: 2,
    } }] };
  }
}
