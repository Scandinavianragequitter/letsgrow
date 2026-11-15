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
  /** Demo data for sources a person hasn't connected (local demo). Off on the live site: unconnected means no data. */
  demoData?: boolean;
  /** The quarantined Gmail checker: which of these emails fit the description. Set by main. */
  judgeMail?: (description: string, mails: google.MailMeta[]) => Promise<Set<string>>;
}

export class ConnectorHub implements Integrations {
  constructor(private d: HubDeps) {}
  /** The Gmail checker lives with the agent; it's handed over once both exist. */
  useMailJudge(judge: NonNullable<HubDeps["judgeMail"]>) { this.d.judgeMail = judge; }
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
    return this.d.store.syncedEvents(userId, from, to).map((e) => ({ title: e.title, startMs: e.start_ms, endMs: e.end_ms, ...(e.all_day ? { allDay: true } : {}) }));
  }

  catalog(userId: string): SourceInfo[] {
    const s = this.status(userId);
    const cal = s.google_calendar || s.apple_calendar;
    const demo = this.d.demoData !== false;
    const until = demo ? "demo data until then" : "no data until then";
    return [
      demo
        ? { source: "screen_time", connected: true, use: "measure", metrics: ["app_minutes:<AppName>", "total_minutes", "pickups"],
            notes: "Demo data: there is no server API for Screen Time." }
        : { source: "screen_time", connected: false, use: "measure",
            notes: "Not available: Screen Time can't be read from a server. Use a daily check-in, or ask for a screenshot of their Screen Time as photo proof." },
      { source: "health", connected: s.apple_health, use: "measure",
        metrics: ["steps", "workout_minutes", "workout_minutes:<Type> e.g. workout_minutes:Rowing", "sleep_hours", "mindful_minutes"],
        notes: s.apple_health ? "Real Apple Health data, pushed daily from their iPhone." :
          `Not connected yet (${until}). request_connection apple_health gives them a setup link (one-time, a few taps on the iPhone).` },
      { source: "calendar", connected: cal, use: "context",
        notes: cal ? `Real calendar (${[s.google_calendar && "Google", s.apple_calendar && "Apple public calendar"].filter(Boolean).join(" + ")}).` :
          `Not connected (${until}). For Google: request_connection google_calendar (one click). For Apple: ask them to share a public calendar link with you in this chat, then connect_calendar_link.` },
      { source: "email", connected: s.gmail, use: "measure", metrics: ["<plain words for which emails count>, e.g. a Canvas notice that an assignment is missing or late"],
        notes: s.gmail ? "Real Gmail (read-only). For a plan: metric = plain words describing which emails count, queryHint = a broad Gmail search that finds candidates (e.g. canvas OR instructure). A separate checker judges each new email within a minute; the day's count is compared with the threshold, so for \"no X\" habits use comparator lte, threshold 0 (one matching email is a slip at once). probe_data_source email takes a Gmail search and returns counts only." :
          s.google_configured ? "Not connected. request_connection gmail gives them a one-click link." : "Unavailable: Google sign-in is not configured on this server." },
    ];
  }

  async probe(userId: string, tz: string, today: string, req: ProbeRequest): Promise<unknown> {
    const s = this.status(userId);
    if (req.source === "calendar" && this.calendarConnected(userId)) {
      const kw = req.keyword?.toLowerCase();
      const events = Array.from({ length: 14 }, (_, i) => addDays(today, i)).flatMap((d) => this.events(userId, d, tz))
        .filter((e) => !kw || e.title.toLowerCase().includes(kw))
        .map((e) => e.allDay ? { title: e.title, allDay: true, day: dayKey(e.startMs, tz) } : { title: e.title, start: fmt(e.startMs, tz), end: fmt(e.endMs, tz) });
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
    if (this.d.demoData === false) return { source: req.source, data: "none", note: "Not connected, so there is no data to look at." };
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
    if (s.gmail) await this.syncMail(userId);
  }

  /** Email habits for everyone with Gmail connected. Runs on its own, faster timer. */
  async syncMailAll() {
    const users = new Set(this.d.store.connections().filter((c) => c.provider === "google").map((c) => c.user_id));
    for (const u of users) await this.syncMail(u).catch((err) => console.warn(`mail check for ${u} failed:`, err.message));
  }

  /**
   * For an email-verified habit: judge each email that arrived since the habit started (once per
   * email, so frequent checks stay cheap) and store how many counted per day. A day's count is what
   * the scheduler compares against the plan, so one matching email can decide the day at once.
   */
  async syncMail(userId: string) {
    const { store } = this.d;
    const user = store.getUser(userId);
    const habit = store.currentHabit(userId);
    const a = habit?.status === "active" && habit.plan_json ? (JSON.parse(habit.plan_json) as HabitPlan).autonomous : undefined;
    if (!user || !habit || a?.source !== "email" || !this.status(userId).gmail || !this.d.judgeMail) return;
    const key = `mail-judged:${habit.id}`;
    const judged = JSON.parse(store.getKv(key) ?? "{}") as Record<string, { day: string; match: boolean }>;
    const since = Math.max(habit.started_at ?? 0, this.d.now() - 2 * 86_400_000);
    const token = await this.googleToken(userId);
    const ids = await google.listMailIds(token, `${a.queryHint ?? "in:inbox"} after:${Math.floor(since / 1000)}`, 50, this.f);
    const fresh = ids.filter((id) => !judged[id]).slice(0, 20);
    if (fresh.length) {
      const mails = await Promise.all(fresh.map((id) => google.mailMeta(token, id, this.f)));
      const hits = await this.d.judgeMail(a.metric, mails);
      for (const m of mails) judged[m.id] = { day: dayKey(m.receivedMs, user.tz), match: hits.has(m.id) };
      store.setKv(key, JSON.stringify(judged));
    }
    const today = dayKey(this.d.now(), user.tz);
    for (const day of [addDays(today, -1), today]) {
      if (habit.start_day && day < habit.start_day) continue;
      store.setSignal(userId, day, `email:${a.metric}`, Object.values(judged).filter((j) => j.day === day && j.match).length);
    }
  }
}

function fmt(ms: number, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
}
