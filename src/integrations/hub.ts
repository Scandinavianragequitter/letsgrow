import type { Store } from "../db.js";
import type { HabitPlan } from "../agent/plan.js";
import { addDays, dayKey, zonedTime } from "../clock.js";
import type { CalEvent, Integrations, MockIntegrations, ProbeRequest, SourceInfo } from "./mock.js";
import { eventsInWindow, fetchIcs, normalizeCalendarUrl } from "./ics.js";
import * as google from "./google.js";

// Real data where the person has connected a source, demo data where they haven't.
// Connected sources are synced into the database on a timer, so the scheduler and verifier keep
// reading synchronously from one place. Provenance ("real" or "demo") is reported to the agent.

export interface HubDeps {
  store: Store;
  mock: MockIntegrations;
  google?: google.GoogleConfig;
  now: () => number;
  fetch?: typeof fetch;
}

export class ConnectorHub implements Integrations {
  constructor(private d: HubDeps) {}
  private get f() { return this.d.fetch ?? fetch; }

  // ---------- what is connected ----------

  status(userId: string) {
    const g = this.d.store.getConnection<google.GoogleTokens>(userId, "google");
    return {
      google_calendar: google.hasScope(g, "calendar"),
      gmail: google.hasScope(g, "gmail"),
      apple_calendar: !!this.d.store.getConnection(userId, "ics"),
      apple_health: !!this.d.store.getConnection<{ lastPushAt?: number }>(userId, "health")?.lastPushAt,
      google_configured: !!this.d.google,
    };
  }
  private calendarConnected(userId: string) {
    const s = this.status(userId);
    return s.google_calendar || s.apple_calendar;
  }

  // ---------- Integrations ----------

  metric(userId: string, source: string, metric: string, day: string): number | null {
    const { store } = this.d;
    const s = this.status(userId);
    if (source === "health" && s.apple_health) return store.getSignal(userId, day, metric);
    if (source === "email") return s.gmail ? store.getSignal(userId, day, `email:${metric}`) : null;
    return this.d.mock.metric(userId, source, metric, day);
  }

  events(userId: string, day: string, tz: string): CalEvent[] {
    if (!this.calendarConnected(userId)) return this.d.mock.events(userId, day, tz);
    const from = zonedTime(day, "00:00", tz), to = zonedTime(addDays(day, 1), "00:00", tz);
    return this.d.store.syncedEvents(userId, from, to).map((e) => ({ title: e.title, startMs: e.start_ms, endMs: e.end_ms }));
  }

  catalog(userId: string): SourceInfo[] {
    const s = this.status(userId);
    const cal = s.google_calendar || s.apple_calendar;
    return [
      { source: "screen_time", connected: true, use: "measure", metrics: ["app_minutes:<AppName>", "total_minutes", "pickups"],
        notes: "Demo data: there is no server API for Screen Time." },
      { source: "health", connected: s.apple_health, use: "measure",
        metrics: ["steps", "workout_minutes", "workout_minutes:<Type> e.g. workout_minutes:Rowing", "sleep_hours", "mindful_minutes"],
        notes: s.apple_health ? "Real Apple Health data, pushed daily from their iPhone." :
          "Not connected yet (demo data until then). request_connection apple_health gives them a setup link (one-time, a few taps on the iPhone)." },
      { source: "calendar", connected: cal, use: "context",
        notes: cal ? `Real calendar (${[s.google_calendar && "Google", s.apple_calendar && "Apple public calendar"].filter(Boolean).join(" + ")}).` :
          "Not connected (demo events until then). For Google: request_connection google_calendar (one click). For Apple: ask them to share a public calendar link with you in this chat, then connect_calendar_link." },
      { source: "email", connected: s.gmail, use: "measure", metrics: ["<Gmail search query>, e.g. from:duolingo subject:streak"],
        notes: s.gmail ? "Real Gmail (read-only, metadata and snippets). Measures: number of matching emails that day." :
          s.google_configured ? "Not connected. request_connection gmail gives them a one-click link." : "Unavailable: Google sign-in is not configured on this server." },
    ];
  }

  async probe(userId: string, tz: string, today: string, req: ProbeRequest): Promise<unknown> {
    const s = this.status(userId);
    if (req.source === "calendar" && this.calendarConnected(userId)) {
      const kw = req.keyword?.toLowerCase();
      const events = Array.from({ length: 14 }, (_, i) => addDays(today, i)).flatMap((d) => this.events(userId, d, tz))
        .filter((e) => !kw || e.title.toLowerCase().includes(kw))
        .map((e) => ({ title: e.title, start: fmt(e.startMs, tz), end: fmt(e.endMs, tz) }));
      return { source: "calendar", data: "real", keyword: req.keyword ?? null, count: events.length, events: events.slice(0, 30) };
    }
    if (req.source === "health" && s.apple_health) {
      const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 7));
      const metrics = req.metric ? [req.metric] : ["steps", "workout_minutes", "sleep_hours", "mindful_minutes"];
      return { source: "health", data: "real", last7Days: Object.fromEntries(metrics.map((m) => [m, days.map((day) => ({ day, value: this.d.store.getSignal(userId, day, m) }))])) };
    }
    if (req.source === "email") {
      if (!s.gmail) return { error: "Gmail is not connected. Use request_connection gmail." };
      if (!req.metric) return { error: "Give a Gmail search query in `metric`, e.g. from:duolingo." };
      const token = await this.googleToken(userId);
      const from = zonedTime(addDays(today, -7), "00:00", tz), to = zonedTime(addDays(today, 1), "00:00", tz);
      const r = await google.searchMail(token, google.dayQuery(req.metric, from, to), 0, this.f);
      // Counts only: email text is written by other people and stays out of the coach's context.
      return { source: "email", data: "real", query: req.metric, matchesLast7Days: r.count };
    }
    return { ...(this.d.mock.probe(userId, tz, today, req) as object), data: "demo" };
  }

  // ---------- connecting ----------

  async connectCalendarLink(userId: string, url: string) {
    const clean = normalizeCalendarUrl(url);
    await fetchIcs(clean, this.f); // validate before saving
    this.d.store.setConnection(userId, "ics", { url: clean }, this.d.now());
    await this.syncUser(userId);
    const user = this.d.store.getUser(userId)!;
    const today = dayKey(this.d.now(), user.tz);
    const upcoming = Array.from({ length: 14 }, (_, i) => addDays(today, i)).flatMap((d) => this.events(userId, d, user.tz));
    return { connected: true, upcomingEvents: upcoming.length, sample: upcoming.slice(0, 5).map((e) => ({ title: e.title, start: fmt(e.startMs, user.tz) })) };
  }

  async completeGoogle(userId: string, code: string) {
    if (!this.d.google) throw new Error("Google sign-in is not configured.");
    const prev = this.d.store.getConnection<google.GoogleTokens>(userId, "google");
    const t = await google.exchangeCode(this.d.google, code, this.d.now(), this.f);
    // include_granted_scopes merges scopes; keep the old refresh token if Google didn't send a new one
    this.d.store.setConnection(userId, "google", { ...t, refresh_token: t.refresh_token ?? prev?.refresh_token }, this.d.now());
    await this.syncUser(userId).catch((err) => console.warn("google sync after connect failed:", err.message));
  }

  private async googleToken(userId: string): Promise<string> {
    if (!this.d.google) throw new Error("Google sign-in is not configured.");
    const t = this.d.store.getConnection<google.GoogleTokens>(userId, "google");
    if (!t) throw new Error("Google is not connected.");
    const fresh = await google.freshTokens(this.d.google, t, this.d.now(), this.f);
    if (fresh !== t) this.d.store.setConnection(userId, "google", fresh, this.d.now());
    return fresh.access_token;
  }

  async searchEmail(userId: string, query: string, days: number) {
    const user = this.d.store.getUser(userId)!;
    const today = dayKey(this.d.now(), user.tz);
    const from = zonedTime(addDays(today, -days + 1), "00:00", user.tz), to = zonedTime(addDays(today, 1), "00:00", user.tz);
    return google.searchMail(await this.googleToken(userId), google.dayQuery(query, from, to), 10, this.f);
  }

  // ---------- syncing ----------

  async syncAll() {
    const users = new Set(this.d.store.connections().map((c) => c.user_id));
    for (const u of users) await this.syncUser(u).catch((err) => console.warn(`sync for ${u} failed:`, err.message));
  }

  async syncUser(userId: string) {
    const { store } = this.d;
    const user = store.getUser(userId);
    if (!user) return;
    const today = dayKey(this.d.now(), user.tz);
    const from = zonedTime(addDays(today, -7), "00:00", user.tz), to = zonedTime(addDays(today, 15), "00:00", user.tz);

    const ics = store.getConnection<{ url: string }>(userId, "ics");
    if (ics) store.replaceSyncedEvents(userId, "ics", from, to, eventsInWindow(await fetchIcs(ics.url, this.f), from, to));

    const s = this.status(userId);
    if (s.google_calendar) {
      store.replaceSyncedEvents(userId, "google", from, to, await google.calendarEvents(await this.googleToken(userId), from, to, this.f));
    }
    if (s.gmail) {
      // Count matching emails for today and yesterday for every email-verified habit.
      const habit = store.currentHabit(userId);
      const plan = habit?.plan_json ? (JSON.parse(habit.plan_json) as HabitPlan) : undefined;
      if (plan?.autonomous?.source === "email") {
        const token = await this.googleToken(userId);
        for (const day of [addDays(today, -1), today]) {
          const a = zonedTime(day, "00:00", user.tz), b = zonedTime(addDays(day, 1), "00:00", user.tz);
          const r = await google.searchMail(token, google.dayQuery(plan.autonomous.metric, a, b), 0, this.f);
          store.setSignal(userId, day, `email:${plan.autonomous.metric}`, r.count);
        }
      }
    }
  }
}

function fmt(ms: number, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
}
