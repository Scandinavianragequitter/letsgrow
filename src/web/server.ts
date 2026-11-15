import { Hono } from "hono";
import QRCode from "qrcode";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Store, UserRow, HabitRow } from "../db.js";
import type { Clock } from "../clock.js";
import { HOUR, dayKey, zonedTime } from "../clock.js";
import type { HabitPlan } from "../agent/plan.js";
import type { Scheduler } from "../engine/scheduler.js";
import type { LetsGrowAgent } from "../agent/agent.js";
import { INVITE_TEXT, type HabitActions } from "../engine/actions.js";
import type { LineAssigner } from "../messaging/assigner.js";
import { ConsoleMessenger, type Messenger } from "../messaging/messenger.js";
import { PRESETS, policyFromPreset, policyFromSuggestion, type EscalationPolicy } from "../policy/escalation.js";
import { computeStats, friendHelp } from "../engine/stats.js";
import { msg } from "../engine/messages.js";
import { normalizePhone } from "../phone.js";
import { config } from "../config.js";

export interface AppDeps {
  /** Set in console mode so the dev panel can pretend a phone texted the line. */
  consoleTransport?: ConsoleMessenger;
  store: Store; clock: Clock; agent: LetsGrowAgent; actions: HabitActions; scheduler: Scheduler;
  messenger: Messenger; assigner: LineAssigner; devPanel: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const asset = (f: string) => readFileSync(join(here, "public", f), "utf8");

export function createApp(d: AppDeps) {
  const consoleTransport = d.consoleTransport;
  const { store, clock } = d;
  const app = new Hono();

  const userOf = (c: Parameters<typeof getCookie>[0]): UserRow | undefined => {
    const t = getCookie(c, "lg_session");
    return t ? store.userForSession(t) : undefined;
  };
  // Make sure a signed-in person is on a Photon line. Covers accounts made before Photon was on,
  // and assignments that were released in the dashboard. Retries at most once a minute.
  const lineChecked = new Map<string, number>();
  async function ensureLine(user: UserRow, force = false): Promise<string | undefined> {
    if (d.messenger.mode !== "photon") return;
    const last = lineChecked.get(user.phone) ?? 0;
    if (!force && Date.now() - last < 60_000) return;
    lineChecked.set(user.phone, Date.now());
    try {
      const r = await d.assigner.assign(user.phone, user.name);
      if (store.getKv(`line:${user.phone}`) !== r.number) store.setKv(`line:${user.phone}`, r.number);
    } catch (err) {
      return `Could not assign you a line yet: ${(err as Error).message}`;
    }
  }
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
      line: (() => { const n = store.getKv(`line:${user.phone}`) ?? config.sharedLineNumber; return { number: n, sms: smsHref(n, "hi") }; })(),
      now: { ms: now, day: dayKey(now, user.tz) },
      habit: habit && {
        id: habit.id, status: habit.status, startDay: habit.start_day, durationDays: habit.duration_days,
        escalation: JSON.parse(habit.escalation_json) as EscalationPolicy,
      },
      plan,
      chat: store.chat(user.id).map((m) => ({ role: m.role, content: m.content, channel: m.channel })),
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

  // QR codes. /qr is a full-screen code for the site itself (put it on the projector);
  // /qr.svg?text=... renders a code for a link on this site (e.g. a friend invite).
  const qrSvg = (text: string) => QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  app.get("/qr.svg", async (c) => {
    const text = c.req.query("text") ?? config.publicBaseUrl;
    if (!text.startsWith(config.publicBaseUrl)) return c.text("Only links to this site.", 400);
    return c.body(await qrSvg(text), 200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
  });
  app.get("/qr", async (c) => c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Let'sGrow</title><style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#fff;color:#111}
.qr{width:min(70vh,80vw)}h1{font-size:clamp(28px,5vw,56px);margin:0 0 16px}p{font-size:clamp(14px,2vw,22px);color:#555;margin:16px 0 0}</style></head>
<body><h1>Let'sGrow</h1><div class="qr">${await qrSvg(config.publicBaseUrl)}</div><p>${config.publicBaseUrl}</p></body></html>`));

  // ---------- user flow ----------
  app.post("/api/signup", async (c) => {
    const b = await c.req.json<{ name?: string; phone?: string }>();
    const name = (b.name ?? "").trim();
    const phone = normalizePhone(b.phone ?? "");
    if (!name || !phone) return c.json({ error: "Enter your name and a valid phone number (with country code if outside the US)." }, 400);
    const user = store.getUserByPhone(phone) ?? store.createUser(name, phone, config.defaultTz, clock.now());
    let warning: string | undefined;
    warning = await ensureLine(user, true);
    setCookie(c, "lg_session", store.createSession(user.id), { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 90 });
    return c.json({ ...view(user), warning });
  });

  app.get("/api/state", async (c) => {
    const user = userOf(c);
    if (!user) return c.json({ user: null }, 200);
    const warning = await ensureLine(user);
    return c.json({ ...view(user), warning });
  });

  app.post("/api/logout", (c) => {
    deleteCookie(c, "lg_session", { path: "/" });
    return c.json({ ok: true });
  });

  app.post("/api/chat", async (c) => {
    const user = userOf(c);
    if (!user) return c.json({ error: "not signed in" }, 401);
    const { message } = await c.req.json<{ message?: string }>();
    const text = (message ?? "").trim();
    if (!text) return c.json({ error: "empty message" }, 400);

    await d.agent.chat(user, text);
    return c.json(view(user));
  });

  app.post("/api/habit/start", async (c) => {
    const user = userOf(c);
    if (!user) return c.json({ error: "not signed in" }, 401);
    let started;
    try { started = d.actions.start(user); }
    catch (err) { return c.json({ error: (err as Error).message }, 400); }
    const now = clock.now();
    if (d.messenger.mode === "console" || user.connected) {
      const text = await d.agent.write({
        to: user.name,
        purpose: "They just started their habit from the website. Confirm it started, say what happens next in one sentence, and ask them to forward the invite message to a friend.",
        facts: { habit: started.plan.title, summary: started.plan.summary, days: started.habit.duration_days, inviteMessageToForward: started.inviteMessage },
        fallback: msg.userStarted(started.plan.title, started.habit.duration_days),
      });
      try { await d.messenger.send(user.phone, text); } catch { /* not reachable yet */ }
    }
    await d.scheduler.tick(now);
    return c.json(view(user));
  });

  app.post("/api/habit/restart", (c) => {
    const user = userOf(c);
    const habit = user && store.currentHabit(user.id);
    if (!user) return c.json({ error: "not signed in" }, 401);
    if (habit) store.setHabitStatus(habit.id, "cancelled");
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
    // The habit stays private until the friend is needed, so the invite page doesn't name it.
    return c.json({ userName: owner.name, days: h.duration_days });
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
      if (d.messenger.mode === "console" && consoleTransport) await consoleTransport.simulateInbound(e);
      else await d.agent.onInbound(e);
      return c.json(view(user));
    });
    app.get("/api/dev/outbox", (c) => c.json(store.recentMessages(80)));
  }

  return app;
}
