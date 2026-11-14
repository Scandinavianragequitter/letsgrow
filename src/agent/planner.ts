import { z } from "zod";
import { HabitPlanSchema, type HabitPlan } from "./plan.js";
import type { LlmClient } from "./llm.js";
import type { Integrations } from "../integrations/mock.js";

export interface PlannerTurn { reply: string; plan?: HabitPlan }

const TOOL = {
  name: "propose_plan",
  description:
    "Propose how Let'sGrow will verify this habit and what (if anything) it will ask of the user. Call it as soon as the habit is concrete enough to verify.",
  schema: z.toJSONSchema(HabitPlanSchema, { io: "input" }) as Record<string, unknown>,
};

export function systemPrompt(integrations: Integrations, userName: string): string {
  return `You are the Let'sGrow habit agent, talking to ${userName}. The user tells you a healthy habit they want to build. Your job: decide how to VERIFY it with the tools available, with as little effort and annoyance for the user as possible.

Tools and data you can use:
${integrations.describe()}

Two ways to verify. Choose one:
1. autonomous: a data source can measure it directly (e.g. "under an hour on Instagram" = screen_time app_minutes:Instagram <= 60, evaluated late in the evening). Zero effort for the user. Always prefer this when a metric fits.
2. prompted: nothing measures it, so you ask, in the least invasive and lowest-burden way. Anchor reminders to the user's real calendar when you can (e.g. "stretch before and after every training": find events whose title contains "training", remind 10 minutes before the start and 5 minutes after the end), and make confirmation one tap: tell them to react with a heart (❤️) to your message. Use fixed_time reminders only when there is no calendar anchor. Prefer few reminders (1 or 2 a day).

Rules:
- If the habit is concrete enough, call propose_plan right away. Ask at most ONE short clarifying question, and only if you cannot pick a threshold or timing (e.g. "less Instagram" with no target).
- After calling propose_plan, your visible reply must be 1 to 3 short sentences that say how you will verify it and what the user has to do (often: nothing, or a heart tap). No bullet lists, no headings, no emojis other than ❤️ where relevant.
- Habit days: use daysOfWeek only if the user implies specific days.
- suggestedMissedDaysBeforeFriendNudge: how many consecutive missed days before the friend's agent should tell the friend. Use 1 for habits where every day matters (e.g. daily limits), 2 or 3 for habits where an occasional slip is normal. This is only a suggestion; the user can change it.
- Be warm and brief. You are not a therapist and you do not lecture.`;
}

export class Planner {
  constructor(private llm: LlmClient, private integrations: Integrations) {}

  async turn(
    userName: string,
    history: { role: "user" | "assistant"; content: string }[],
    userMessage: string,
  ): Promise<PlannerTurn> {
    const system = systemPrompt(this.integrations, userName);
    const messages = [...history, { role: "user" as const, content: userMessage }];

    let out = await this.llm.complete({ system, messages, tool: TOOL });
    let call = out.toolCalls.find((c) => c.name === TOOL.name);

    if (call) {
      let parsed = HabitPlanSchema.safeParse(call.input);
      if (!parsed.success) {
        // One repair attempt: show the model what was wrong.
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        out = await this.llm.complete({
          system,
          messages: [...messages, { role: "user", content: `Your plan was invalid (${issues}). Call propose_plan again with a corrected plan.` }],
          tool: TOOL,
        });
        call = out.toolCalls.find((c) => c.name === TOOL.name);
        parsed = call ? HabitPlanSchema.safeParse(call.input) : parsed;
      }
      if (parsed.success) {
        const reply = out.text && out.text.length <= 500 ? out.text : parsed.data.summary;
        return { reply, plan: parsed.data };
      }
      return { reply: "I could not turn that into a plan I can verify. Can you say it a bit more concretely, for example with a number or a time?" };
    }
    return { reply: out.text || "Tell me about the habit you want to build." };
  }
}
