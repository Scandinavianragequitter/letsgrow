import type { Store } from "../db.js";
import { addDays, weekday, zonedTime } from "../clock.js";

// Mock data sources for the demo. The real versions would call Apple Screen Time
// (only reachable through an iOS app using FamilyControls), HealthKit / Google Health,
// and Google/Apple Calendar. Keep the same two methods when swapping them in.

/** A calendar event. All-day events have allDay set and are pinned to noon UTC of their date (so they fall on that date in any US/EU time zone). */
export interface CalEvent { title: string; startMs: number; endMs: number; allDay?: boolean }

/** Noon UTC of a calendar date: how all-day events are stored. */
export function allDayMs(y: number, m: number, d: number): number { return Date.UTC(y, m - 1, d, 12); }

export type SourceId = "screen_time" | "health" | "calendar" | "email";

export interface SourceInfo {
  source: SourceId;
  connected: boolean;
  /** "measure": can verify a habit with no user effort. "context": helps time reminders. */
  use: "measure" | "context";
  metrics?: string[];
  notes: string;
}

export interface ProbeRequest { source: SourceId; metric?: string; keyword?: string }

export interface Integrations {
  /** Numeric reading for a metric on a day, or null if the source has no data. */
  metric(userId: string, source: string, metric: string, day: string): number | null;
  events(userId: string, day: string, tz: string): CalEvent[];
  /** What this user has connected. The agent reads this instead of a hardcoded description. */
  catalog(userId: string): SourceInfo[];
  /** Look at this user's actual data so plans are grounded in what exists. */
  probe(userId: string, tz: string, today: string, req: ProbeRequest): unknown | Promise<unknown>;
}

const SCREEN_TIME_APPS = ["Instagram", "TikTok", "YouTube", "WhatsApp", "Safari", "X", "Reddit"];
const HEALTH_METRICS = ["steps", "workout_minutes", "sleep_hours", "mindful_minutes"];

function localTime(ms: number, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
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

  catalog(_userId: string): SourceInfo[] {
    return [
      { source: "screen_time", connected: true, use: "measure", metrics: ["app_minutes:<AppName>", "total_minutes", "pickups"],
        notes: "Daily totals per app from Screen Time. Demo data." },
      { source: "health", connected: true, use: "measure", metrics: HEALTH_METRICS,
        notes: "Daily totals from the health app. Demo data." },
      { source: "calendar", connected: true, use: "context",
        notes: "The user's events (title, start, end). Use to time reminders around real events. Demo data." },
    ];
  }

  probe(userId: string, tz: string, today: string, req: ProbeRequest): unknown {
    const past = Array.from({ length: 7 }, (_, i) => addDays(today, i - 7));
    const series = (source: string, metric: string) =>
      past.map((day) => ({ day, value: this.metric(userId, source, metric, day) }));
    if (req.source === "email") return { error: "No email connected." };
    if (req.source === "screen_time" || req.source === "health") {
      if (req.metric) return { source: req.source, metric: req.metric, last7Days: series(req.source, req.metric) };
      const metrics = req.source === "screen_time"
        ? [...SCREEN_TIME_APPS.map((a) => `app_minutes:${a}`), "total_minutes", "pickups"]
        : HEALTH_METRICS;
      return {
        source: req.source,
        dailyAverageLast7Days: Object.fromEntries(metrics.map((m) => {
          const v = series(req.source, m).map((x) => x.value).filter((x): x is number => x !== null);
          return [m, v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null];
        })),
      };
    }
    const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));
    const kw = req.keyword?.toLowerCase();
    const events = days.flatMap((d) => this.events(userId, d, tz))
      .filter((e) => !kw || e.title.toLowerCase().includes(kw))
      .map((e) => ({ title: e.title, start: localTime(e.startMs, tz), end: localTime(e.endMs, tz) }));
    return { source: "calendar", window: `${today} + 14 days`, keyword: req.keyword ?? null, count: events.length, events: events.slice(0, 30) };
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
