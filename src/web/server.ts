import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Store, UserRow, HabitRow } from "../db.js";
import type { Clock } from "../clock.js";
import { HOUR, dayKey, zonedTime } from "../clock.js";
import type { Planner } from "../agent/planner.js";
import type { HabitPlan } from "../agent/plan.js";
import type { Scheduler } from "../engine/scheduler.js";
import type { InboundRouter } from "../engine/inbound.js";
import type { LineAssigner } from "../messaging/assigner.js";
import { ConsoleMessenger, type Messenger } from "../messaging/messenger.js";
import { PRESETS, policyFromPreset, policyFromSuggestion, type EscalationPolicy } from "../policy/escalation.js";
import { computeStats, friendHelp } from "../engine/stats.js";
import { msg } from "../engine/messages.js";
import { normalizePhone } from "../phone.js";
import { config } from "../config.js";

export interface AppDeps {
  store: Store; clock: Clock; planner: Planner; scheduler: Scheduler; router: InboundRouter;
  messenger: Messenger; assigner: LineAssigner; devPanel: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const asset = (f: string) => readFileSync(join(here, "public", f), "utf8");
const INVITE_TEXT = "Remind me if I'm late on my new healthy habit. Let's grow!";

export function createApp(d: AppDeps) {
  const { store, clock } = d;
  const app = new Hono();

  const userOf = (c: Parameters<typeof getCookie>[0]): UserRow | undefined => {
    const t = getCookie(c, "lg_session");
    return t ? store.userForSession(t) : undefined;
  };
  const smsHref = (number: string, body: string) => `sms:${number}&body=${encodeURIComponent(body)}`;

  function view(user: UserRow) {
    const now = clock.now();
    const habit = store.currentHabit(user.id);
    const plan = habit?.plan_json ? (JSON.parse(habit.plan_json) as HabitPlan) : null;
    const inviteUrl = habit ? `${config.publicBaseUrl}/join/${habit.invite_token}` : null;
    let friends: unknown[] = [];
    let stats = null;
    if (habit) {
      const help = friendHelp(store, habit.id);
      friends = store.friends(habit.id).map((f) => ({
        name: f.name, phone: f.phone, state: f.state,
        nudges: help.get(f.id)?.nudges ?? 0, replies: help.get(f.id)?.replies ?? 0,
      }));
      stats = computeStats(store, habit);
    }
    return {
      user: { name: user.name, phone: user.phone, connected: !!user.connected, tz: user.tz },
      line: { number: config.sharedLineNumber, sms: smsHref(config.sharedLineNumber, "hi") },
      now: { ms: now, day: dayKey(now, user.tz) },
      habit: habit && {
        id: habit.id, status: habit.status, startDay: habit.start_day, durationDays: habit.duration_days,
        escalation: JSON.parse(habit.escalation_json) as EscalationPolicy,
      },
      plan,
      chat: store.chat(user.id).map((m) => ({ role: m.role, content: m.content })),
      days: habit ? store.days(habit.id).map((x) => ({ day: x.day, status: x.status, detail: x.detail })) : [],
      stats, friends,
      invite: inviteUrl && { url: inviteUrl, text: `${INVITE_TEXT} ${inviteUrl}`, sms: `sms:&body=${encodeURIComponent(`${INVITE_TEXT} ${inviteUrl}`)}` },
      presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, policy: policyFromPreset(id) })),
      dev: d.devPanel, messengerMode: d.messenger.mode,
    };
  }

  // ---------- pages ----------
  app.get("/", (c) => c.html(asset("index.html")));
  app.get("/app.js", (c) => c.body(asset("app.js"), 200, { "content-type": "text/javascript" }));
  app.get("/style.css", (c) => c.body(asset("style.css"), 200, { "content-type": "text/css" }));
  app.get("/join/:token", (c) => c.html(asset("join.html")));

  // ---------- user flow ----------
  app.post("/api/signup", async (c) => {
    const b = await c.req.json<{ name?: string; phone?: string }>();
    const name = (b.name ?? "").trim();
    const phone = normalizePhone(b.phone ?? "");
    if (!name || !phone) return c.json({ error: "Enter your name and a valid phone number (with country code if outside the US)." }, 400);
    const user = store.getUserByPhone(phone) ?? store.createUser(name, phone, config.defaultTz, clock.now());
    let warning: string | undefined;
    try { await d.assigner.assign(phone, name); }
    catch (err) { warning = `Could not assign you a line yet: ${(err as Error).message}`; }
    setCookie(c, "lg_session", store.createSession(user.id), { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 90 });
    return c.json({ ...view(user), warning });
  });

  app.get("/api/state", (c) => {
    const user = userOf(c);
    return user ? c.json(view(user)) : c.json({ user: null }, 200);
  });

  app.post("/api/chat", async (c) => {
    const user = userOf(c);
    if (!user) return c.json({ error: "not signed in" }, 401);
    const { message } = await c.req.json<{ message?: string }>();
    const text = (message ?? "").trim();
    if (!text) return c.json({ error: "empty message" }, 400);

    let habit = store.currentHabit(user.id);
    if (habit && habit.status !== "planning") return c.json({ error: "You already have a habit running. Start over to plan a new one." }, 409);
    if (!habit) habit = store.createHabit(user.id, text, config.durationDays, JSON.stringify(policyFromPreset("standard")), clock.now());

    const history = store.chat(user.id).map((m) => ({ role: m.role, content: m.content }));
    try {
      const turn = await d.planner.turn(user.name, history, text);
      store.addChat(user.id, "user", text, clock.now());
      store.addChat(user.id, "assistant", turn.reply, clock.now());
      if (turn.plan) {
        store.setPlan(habit.id, JSON.stringify(turn.plan), turn.plan.title);
        store.setEscalation(habit.id, JSON.stringify(policyFromSuggestion(turn.plan.suggestedMissedDaysBeforeFriendNudge)));
      }
      return c.json(view(user));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 503);
    }
  });

  app.post("/api/habit/start", async (c) => {
    const user = userOf(c);
    const habit = user && store.currentHabit(user.id);
    if (!user || !habit || habit.status !== "planning" || !habit.plan_json) return c.json({ error: "No plan to start yet." }, 400);
    const now = clock.now();
    store.activateHabit(habit.id, dayKey(now, user.tz), now);
    const plan = JSON.parse(habit.plan_json) as HabitPlan;
    try { if (d.messenger.mode === "console" || user.connected) await d.messenger.send(user.phone, msg.userStarted(plan.title, habit.duration_days)); } catch { /* not connected yet */ }
    await d.scheduler.tick(now);
    return c.json(view(user));
  });

  app.post("/api/habit/restart", (c) => {
    const user = userOf(c);
    const habit = user && store.currentHabit(user.id);
    if (!user) return c.json({ error: "not signed in" }, 401);
    if (habit) store.setHabitStatus(habit.id, "cancelled");
    store.clearChat(user.id);
    return c.json(view(user));
  });

  app.patch("/api/habit/escalation", async (c) => {
    const user = userOf(c);
    const habit = user && store.currentHabit(user.id);
    if (!user || !habit) return c.json({ error: "no habit" }, 400);
    const b = await c.req.json<{ preset?: string; policy?: Partial<EscalationPolicy> }>();
    const current = JSON.parse(habit.escalation_json) as EscalationPolicy;
    const next: EscalationPolicy = b.preset && PRESETS[b.preset] ? policyFromPreset(b.preset) : { ...current, ...(b.policy ?? {}) };
    store.setEscalation(habit.id, JSON.stringify(next));
    return c.json(view(user));
  });

  // ---------- friend flow ----------
  const joinable = (token: string): HabitRow | undefined => {
    const h = store.getHabitByToken(token);
    return h && h.status === "active" ? h : undefined;
  };

  app.get("/api/join/:token", (c) => {
    const h = joinable(c.req.param("token"));
    if (!h) return c.json({ error: "This invite is not active." }, 404);
    const owner = store.getUser(h.user_id)!;
    return c.json({ userName: owner.name, title: (JSON.parse(h.plan_json!) as HabitPlan).title, days: h.duration_days });
  });

  app.post("/api/join/:token", async (c) => {
    const h = joinable(c.req.param("token"));
    if (!h) return c.json({ error: "This invite is not active." }, 404);
    const b = await c.req.json<{ name?: string; phone?: string }>();
    const name = (b.name ?? "").trim();
    const phone = normalizePhone(b.phone ?? "");
    if (!name || !phone) return c.json({ error: "Enter your name and a valid phone number." }, 400);
    const owner = store.getUser(h.user_id)!;
    if (phone === owner.phone) return c.json({ error: "Use a different phone than the person building the habit." }, 400);
    let number = config.sharedLineNumber;
    try { number = (await d.assigner.assign(phone, name)).number; }
    catch (err) { return c.json({ error: `Could not set up your line: ${(err as Error).message}` }, 502); }
    store.addFriend(h.id, name, phone, number, clock.now());
    return c.json({ number, sms: smsHref(number, "ping"), userName: owner.name });
  });

  // ---------- dev panel (demo helpers) ----------
  if (d.devPanel) {
    const need = (c: Parameters<typeof getCookie>[0]) => userOf(c);

    app.post("/api/dev/skip", async (c) => {
      const user = need(c);
      if (!user) return c.json({ error: "not signed in" }, 401);
      const { days = 1 } = await c.req.json<{ days?: number }>();
      for (let i = 0; i < Math.min(days, 90) * 24; i++) { clock.advance(HOUR); await d.scheduler.tick(clock.now()); }
      return c.json(view(user));
    });
    app.post("/api/dev/tick", async (c) => {
      const user = need(c);
      if (!user) return c.json({ error: "not signed in" }, 401);
      await d.scheduler.tick(clock.now());
      return c.json(view(user));
    });
    app.post("/api/dev/signal", async (c) => {
      const user = need(c);
      if (!user) return c.json({ error: "not signed in" }, 401);
      const { key, value, day } = await c.req.json<{ key: string; value: number; day?: string }>();
      store.setSignal(user.id, day ?? dayKey(clock.now(), user.tz), key, Number(value));
      return c.json(view(user));
    });
    app.post("/api/dev/event", async (c) => {
      const user = need(c);
      if (!user) return c.json({ error: "not signed in" }, 401);
      const { title, start, end, day } = await c.req.json<{ title: string; start: string; end: string; day?: string }>();
      const dk = day ?? dayKey(clock.now(), user.tz);
      store.addMockEvent(user.id, dk, title, zonedTime(dk, start, user.tz), zonedTime(dk, end, user.tz));
      return c.json(view(user));
    });
    app.post("/api/dev/inbound", async (c) => {
      const user = need(c);
      if (!user) return c.json({ error: "not signed in" }, 401);
      const e = await c.req.json<{ handle: string; kind: "text" | "reaction"; text?: string; emoji?: string }>();
      if (d.messenger instanceof ConsoleMessenger) await d.messenger.simulateInbound(e);
      else await d.router.handle(e);
      return c.json(view(user));
    });
    app.get("/api/dev/outbox", (c) => c.json(store.recentMessages(80)));
  }

  return app;
}
