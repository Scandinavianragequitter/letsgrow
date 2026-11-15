import { z } from "zod";
import type { LlmClient } from "./llm.js";
import { runAgent } from "./runtime.js";
import type { CalEvent } from "../integrations/mock.js";

/**
 * Which of a day's calendar events a reminder is for. A judgement call, so the model makes it:
 * "a Long Run is a workout" shouldn't depend on a word list. Code decides the timing afterwards.
 */
export type MatchEvents = (description: string, events: CalEvent[], tz: string) => Promise<number[]>;

/** Without a model: an event matches if its title contains a word from the description. */
export function wordMatch(description: string, events: CalEvent[]): number[] {
  const words = description.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  return events.flatMap((e, i) => (words.some((w) => e.title.toLowerCase().includes(w)) ? [i] : []));
}

export function llmMatcher(llm: LlmClient): MatchEvents {
  return async (description, events, tz) => {
    if (events.length === 0) return [];
    const time = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ms);
    const list = events.map((e, i) => `${i}. ${e.title} — ${e.allDay ? "all day" : `${time(e.startMs)}–${time(e.endMs)}`}`).join("\n");
    let picked: number[] | undefined;
    try {
      await runAgent({
        llm,
        maxSteps: 2,
        system: "You decide which calendar events a habit reminder is for. Use judgement about what each event is, not exact words: a \"Long Run\", \"Group Ride\" or \"Brick\" is a workout even if the description doesn't name it. All-day events count when they fit. Leave out events that don't fit (travel, meetings, holidays, birthdays). Call report_matches once.",
        input: `Reminder is for: ${description}\n\nToday's events:\n${list}`,
        tools: [{
          name: "report_matches",
          description: "Report the numbers of the events that fit. Empty list if none.",
          input: z.object({ events: z.array(z.number().int().min(0)) }),
          run: (i: { events: number[] }) => { picked = i.events.filter((n) => n < events.length); return { ok: true }; },
        }],
      });
    } catch (err) {
      console.warn("event matching fell back to words:", (err as Error).message);
    }
    return picked ?? wordMatch(description, events);
  };
}
