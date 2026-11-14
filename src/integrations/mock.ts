import type { Store } from "../db.js";
import { weekday, zonedTime } from "../clock.js";

// Mock data sources for the demo. The real versions would call Apple Screen Time
// (only reachable through an iOS app using FamilyControls), HealthKit / Google Health,
// and Google/Apple Calendar. Keep the same two methods when swapping them in.

export interface CalEvent { title: string; startMs: number; endMs: number }

export interface Integrations {
  /** Numeric reading for a metric on a day, or null if the source has no data. */
  metric(userId: string, source: string, metric: string, day: string): number | null;
  events(userId: string, day: string, tz: string): CalEvent[];
  describe(): string;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rand(seed: string): number {
  let t = (hash(seed) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export class MockIntegrations implements Integrations {
  constructor(private store: Store, private autofill: boolean) {}

  describe(): string {
    return [
      "screen_time (autonomous): metrics `app_minutes:<AppName>` (e.g. app_minutes:Instagram), `total_minutes`, `pickups`. Daily totals.",
      "health (autonomous): metrics `steps`, `workout_minutes`, `sleep_hours`, `mindful_minutes`. Daily totals.",
      "calendar (read-only): the user's events with title, start and end. Use it to anchor reminders to real events (e.g. a training session).",
      "imessage (outbound): can text the user. A single heart tapback or one-word reply is the cheapest confirmation for the user.",
    ].join("\n");
  }

  metric(userId: string, _source: string, metric: string, day: string): number | null {
    const set = this.store.getSignal(userId, day, metric);
    if (set !== null) return set;
    if (!this.autofill) return null;
    const r = rand(`${userId}|${day}|${metric}`);
    if (metric.startsWith("app_minutes")) return Math.round(20 + r ** 3 * 95); // mostly on the low side, with bad days
    switch (metric) {
      case "total_minutes": return Math.round(120 + r * 240);
      case "pickups": return Math.round(30 + r * 70);
      case "steps": return Math.round(3000 + r * 9000);
      case "workout_minutes": return r < 0.55 ? Math.round(20 + r * 60) : 0;
      case "sleep_hours": return Math.round((5 + r * 4) * 10) / 10;
      case "mindful_minutes": return Math.round(r * 20);
      default: return null;
    }
  }

  events(userId: string, day: string, tz: string): CalEvent[] {
    const out: CalEvent[] = this.store.listMockEvents(userId, day).map((e) => ({
      title: e.title, startMs: e.start_ms, endMs: e.end_ms,
    }));
    if (this.autofill) {
      const wd = weekday(day);
      const add = (title: string, a: string, b: string) =>
        out.push({ title, startMs: zonedTime(day, a, tz), endMs: zonedTime(day, b, tz) });
      if ([1, 3, 5].includes(wd)) add("Training", "18:00", "19:30");
      if ([2, 4].includes(wd)) add("Lecture", "14:00", "15:15");
    }
    return out.sort((x, y) => x.startMs - y.startMs);
  }
}
