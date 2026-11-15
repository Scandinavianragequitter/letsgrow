import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { Store } from "../src/db.js";
import { MockIntegrations } from "../src/integrations/mock.js";
import { ConnectorHub } from "../src/integrations/hub.js";
import { ConnectLinks } from "../src/engine/connect.js";
import { registerConnectRoutes } from "../src/web/connect-routes.js";
import { parseHealthPayload } from "../src/integrations/health.js";
import { SCOPES } from "../src/integrations/google.js";
import { zonedTime, dayKey, addDays } from "../src/clock.js";

const TZ = "America/New_York";
const NOW = zonedTime("2026-11-16", "09:00", TZ); // a Monday
const GOOGLE = { clientId: "cid", clientSecret: "secret", redirectUri: "http://localhost:3000/oauth/google/callback" };

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:a
DTSTART:20261116T230000Z
DTEND:20261117T003000Z
RRULE:FREQ=WEEKLY;BYDAY=MO,TH
SUMMARY:Rowing club
END:VEVENT
END:VCALENDAR`;

/** One fake internet: calendar link, Google token/Calendar/Gmail endpoints. */
function fakeNet() {
  const calls: string[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://p01-caldav.icloud.com/")) return new Response(ICS, { status: 200 });
    if (url === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(String(init?.body));
      const scope = body.get("code") === "gmail-code" ? `${SCOPES.calendar} ${SCOPES.gmail}` : SCOPES.calendar;
      return json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope });
    }
    if (url.includes("/calendar/v3/users/me/calendarList")) return json({ items: [{ id: "primary", selected: true }] });
    if (url.includes("/calendar/v3/calendars/primary/events")) return json({ items: [
      { summary: "Leg day", start: { dateTime: "2026-11-17T17:00:00-05:00" }, end: { dateTime: "2026-11-17T18:00:00-05:00" } },
      { summary: "Holiday", start: { date: "2026-11-26" }, end: { date: "2026-11-27" } },
    ] });
    if (url.includes("/gmail/v1/users/me/messages?")) {
      const q = new URL(url).searchParams.get("q") ?? "";
      return json({ messages: q.includes("duolingo") ? [{ id: "m1" }] : [] });
    }
    if (url.includes("/gmail/v1/users/me/messages/m1")) return json({ snippet: "You kept your streak!", payload: { headers: [
      { name: "From", value: "Duolingo <hello@duolingo.com>" }, { name: "Subject", value: "17 day streak" }, { name: "Date", value: "Mon, 16 Nov 2026 08:00:00 -0500" }] } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

function setup(google = true) {
  const store = new Store(":memory:");
  const net = fakeNet();
  const hub = new ConnectorHub({ store, mock: new MockIntegrations(store, true), google: google ? GOOGLE : undefined, now: () => NOW, fetch: net.f });
  const links = new ConnectLinks({ store, publicBaseUrl: "https://demo.example", googleRedirectUri: GOOGLE.redirectUri, now: () => NOW });
  const user = store.createUser("Carl", "+15404492120", TZ, 0);
  const connected: string[] = [];
  const app = new Hono();
  registerConnectRoutes(app, { store, hub, links, google: google ? GOOGLE : undefined, now: () => NOW, onConnected: (_u, what) => { connected.push(what); } });
  return { store, hub, links, user, app, connected, net };
}

test("without connections the agent sees demo data, and says so", async () => {
  const s = setup();
  assert.equal(s.hub.events(s.user.id, "2026-11-16", TZ)[0].title, "Training"); // demo event
  const p = await s.hub.probe(s.user.id, TZ, "2026-11-16", { source: "calendar" }) as any;
  assert.equal(p.data, "demo");
  assert.deepEqual(s.hub.catalog(s.user.id).map((x) => x.connected), [true, false, false, false]);
});

test("Apple public calendar link: webcal is fetched over https, recurrences expanded, demo events replaced", async () => {
  const s = setup();
  const r = await s.hub.connectCalendarLink(s.user.id, "webcal://p01-caldav.icloud.com/published/2/abc");
  assert.equal(r.connected, true);
  assert.ok(s.net.calls[0].startsWith("https://p01-caldav.icloud.com/"));
  const mon = s.hub.events(s.user.id, "2026-11-16", TZ);
  assert.deepEqual(mon.map((e) => e.title), ["Rowing club"], "real event only, no demo Training");
  assert.equal(new Date(mon[0].startMs).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }), "6:00 PM");
  assert.equal(s.hub.events(s.user.id, "2026-11-19", TZ)[0].title, "Rowing club"); // Thursday
  assert.equal(s.hub.events(s.user.id, "2026-11-17", TZ).length, 0);
  await assert.rejects(s.hub.connectCalendarLink(s.user.id, "not a link"), /doesn't look like a calendar link/);
});

test("Google: the link goes to Google's consent screen, the callback connects Calendar, events sync", async () => {
  const s = setup();
  const { link, note } = s.links.link(s.user.id, "google_calendar");
  assert.match(note!, /laptop/);
  const t = new URL(link).searchParams.get("t")!;
  const go = await s.app.request(`/connect/google?t=${t}&p=calendar`);
  assert.equal(go.status, 302);
  const auth = new URL(go.headers.get("location")!);
  assert.equal(auth.host, "accounts.google.com");
  assert.equal(auth.searchParams.get("scope"), SCOPES.calendar);
  assert.equal(auth.searchParams.get("access_type"), "offline");

  const cb = await s.app.request(`/oauth/google/callback?code=cal-code&state=${t}`);
  assert.equal(cb.status, 200);
  assert.match(await cb.text(), /Google Calendar connected/);
  assert.deepEqual(s.connected, ["Google Calendar"]);
  assert.equal(s.hub.status(s.user.id).google_calendar, true);
  assert.deepEqual(s.hub.events(s.user.id, "2026-11-17", TZ).map((e) => e.title), ["Leg day"], "timed events only");
  assert.equal((await s.app.request(`/connect/google?t=bogus`)).status, 410);
});

test("Gmail: connecting adds the scope, search returns metadata only, email habits are counted per day", async () => {
  const s = setup();
  const t = new URL(s.links.link(s.user.id, "gmail").link).searchParams.get("t")!;
  await s.app.request(`/oauth/google/callback?code=gmail-code&state=${t}`);
  assert.equal(s.hub.status(s.user.id).gmail, true);

  const r = await s.hub.searchEmail(s.user.id, "from:duolingo", 7);
  assert.deepEqual(r.messages[0], { from: "Duolingo <hello@duolingo.com>", subject: "17 day streak", date: "Mon, 16 Nov 2026 08:00:00 -0500", snippet: "You kept your streak!" });

  const habit = s.store.createHabit(s.user.id, "duolingo daily", 60, "{}", NOW);
  s.store.setPlan(habit.id, JSON.stringify({ title: "Duolingo every day", summary: "x", mode: "autonomous",
    autonomous: { source: "email", metric: "from:duolingo", comparator: "gte", threshold: 1, evaluateAt: "23:00" }, suggestedMissedDaysBeforeFriendNudge: 1 }), "x");
  await s.hub.syncUser(s.user.id);
  assert.equal(s.hub.metric(s.user.id, "email", "from:duolingo", "2026-11-16"), 1);
  const q = s.net.calls.find((u) => u.includes("messages?q="))!;
  assert.match(new URL(q).searchParams.get("q")!, /after:\d+ before:\d+/, "searches are limited to the day");
});

test("Apple Health: the setup page shows a personal address; uploads replace demo data", async () => {
  const s = setup();
  const t = new URL(s.links.link(s.user.id, "apple_health").link).searchParams.get("t")!;
  const page = await (await s.app.request(`/connect/health?t=${t}`)).text();
  const upload = page.match(/https:\/\/demo\.example\/ingest\/health\/[\w-]+/)![0];
  const path = new URL(upload).pathname;

  assert.equal(s.hub.status(s.user.id).apple_health, false, "not connected until data arrives");
  const res = await s.app.request(path, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps: 8123, workouts: [{ type: "Indoor Rowing", minutes: 31 }], sleep_hours: 7.25 }) });
  assert.equal(res.status, 200);
  assert.deepEqual(s.connected, ["Apple Health"]);
  const today = dayKey(NOW, TZ);
  assert.equal(s.hub.metric(s.user.id, "health", "steps", today), 8123);
  assert.equal(s.hub.metric(s.user.id, "health", "workout_minutes:Rowing", today), 31);
  assert.equal(s.hub.metric(s.user.id, "health", "workout_minutes", today), 31);
  assert.equal(s.hub.metric(s.user.id, "health", "steps", addDays(today, -1)), null, "no more demo values once connected");
  assert.equal((await s.app.request("/ingest/health/nope", { method: "POST", body: "{}" })).status, 404);
});

test("Health Auto Export's format is understood too", () => {
  const days = parseHealthPayload({ data: {
    metrics: [{ name: "step_count", units: "count", data: [{ date: "2026-11-15 00:00:00 -0500", qty: 4000 }, { date: "2026-11-15 12:00:00 -0500", qty: 2500 }] },
              { name: "sleep_analysis", data: [{ date: "2026-11-15 00:00:00 -0500", totalSleep: 6.5 }] }],
    workouts: [{ name: "Indoor Rowing", start: "2026-11-15 18:02:00 -0500", duration: 1860 }],
  } }, "2026-11-16");
  assert.deepEqual(days, [{ day: "2026-11-15", values: { steps: 6500, sleep_hours: 6.5, "workout_minutes:Rowing": 31 } }]);
});

test("without Google credentials the server says so instead of failing", async () => {
  const s = setup(false);
  const t = new URL(s.links.link(s.user.id, "google_calendar").link).searchParams.get("t")!;
  assert.equal((await s.app.request(`/connect/google?t=${t}`)).status, 503);
  assert.match(s.hub.catalog(s.user.id)[3].notes, /not configured/);
});

test("agent: a calendar link sent in iMessage gets connected, and it can hand out connect links", async () => {
  const { LetsGrowAgent } = await import("../src/agent/agent.js");
  const { HabitActions } = await import("../src/engine/actions.js");
  const { ConsoleMessenger } = await import("../src/messaging/messenger.js");
  const { ScriptedLlm, call } = await import("./fake-llm.js");
  const s = setup();
  s.store.markUserConnected(s.user.id);
  const results: any[] = [];
  const llm = new ScriptedLlm((c) => {
    const tool = c.messages.filter((m) => m.role === "tool");
    const last = c.messages.find((m) => m.role === "user")!.content as string;
    if (tool.length) { results.push(JSON.parse((tool.at(-1) as any).content)); return { text: "Got it.", toolCalls: [] }; }
    if (last.startsWith("webcal://")) return call("connect_calendar_link", { url: last });
    return call("request_connection", { connector: "apple_health" });
  });
  const transport = new ConsoleMessenger(s.store, () => NOW);
  const agent = new LetsGrowAgent({ store: s.store, llm, integrations: s.hub, actions: new HabitActions({ store: s.store, durationDays: 60, publicBaseUrl: "https://demo.example", now: () => NOW }),
    messenger: transport, now: () => NOW, hub: s.hub, links: s.links });
  await agent.onInbound({ handle: s.user.phone, kind: "text", text: "webcal://p01-caldav.icloud.com/published/2/abc" });
  assert.equal(results[0].connected, true);
  assert.match(llm.calls[0].system, /"apple_calendar": false/);
  await agent.onInbound({ handle: s.user.phone, kind: "text", text: "how do I connect health?" });
  assert.match(results[1].link, /^https:\/\/demo\.example\/connect\/health\?t=/);
  assert.match(llm.calls.at(-1)!.system, /"apple_calendar": true/, "the agent now sees the calendar as connected");
});
