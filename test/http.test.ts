import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.js";
import { Clock } from "../src/clock.js";
import { MockIntegrations } from "../src/integrations/mock.js";
import { ConsoleMessenger } from "../src/messaging/messenger.js";
import { ConsoleAssigner } from "../src/messaging/assigner.js";
import { Scheduler } from "../src/engine/scheduler.js";
import { InboundRouter } from "../src/engine/inbound.js";
import { Planner } from "../src/agent/planner.js";
import type { LlmClient } from "../src/agent/llm.js";
import { createApp } from "../src/web/server.js";
import { instagramPlan } from "./helpers.js";

function build() {
  const store = new Store(":memory:");
  const clock = new Clock(1);
  const messenger = new ConsoleMessenger(store, () => clock.now());
  const integrations = new MockIntegrations(store, true);
  const llm: LlmClient = { async complete() { return { text: "I'll check Screen Time each evening. Nothing for you to do.", toolCalls: [{ name: "propose_plan", input: instagramPlan }] }; } };
  const router = new InboundRouter(store, messenger, () => clock.now());
  void messenger.start((e) => router.handle(e));
  const scheduler = new Scheduler({ store, integrations, messenger, publicBaseUrl: "http://localhost:3000" });
  const app = createApp({ store, clock, planner: new Planner(llm, integrations), scheduler, router, messenger, assigner: new ConsoleAssigner("+16289988199"), devPanel: true });
  return { app, store };
}

test("full product flow over HTTP", async () => {
  const { app, store } = build();
  let cookie = "";
  const call = async (path: string, method = "GET", body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };

  // signed out
  assert.equal((await call("/api/state")).json.user, null);
  assert.equal((await call("/api/signup", "POST", { name: "Carl", phone: "nope" })).status, 400);

  // signup
  const su = await call("/api/signup", "POST", { name: "Carl", phone: "(540) 449-2120" });
  assert.equal(su.status, 200);
  assert.equal(su.json.user.phone, "+15404492120");
  assert.equal(su.json.line.number, "+16289988199");

  // chat -> plan
  const chat = await call("/api/chat", "POST", { message: "I want to spend less time on Instagram. Under an hour a day" });
  assert.equal(chat.status, 200);
  assert.equal(chat.json.plan.mode, "autonomous");
  assert.equal(chat.json.habit.status, "planning");
  assert.equal(chat.json.habit.escalation.missedDaysBeforeNudge, 2); // from the planner's suggestion
  assert.equal(chat.json.chat.length, 2);

  // escalation can be adjusted before and after starting
  const esc = await call("/api/habit/escalation", "PATCH", { preset: "immediate" });
  assert.equal(esc.json.habit.escalation.missedDaysBeforeNudge, 1);

  // start
  const started = await call("/api/habit/start", "POST");
  assert.equal(started.json.habit.status, "active");
  assert.match(started.json.invite.text, /Remind me if I'm late on my new healthy habit\. Let's grow! http/);
  assert.equal((await call("/api/chat", "POST", { message: "again" })).status, 409);

  // friend joins via the link
  const token = started.json.invite.url.split("/").pop();
  const info = await call(`/api/join/${token}`);
  assert.equal(info.json.userName, "Carl");
  assert.equal((await call(`/api/join/${token}`, "POST", { name: "Anna", phone: "+15404492120" })).status, 400); // same phone as Carl
  const join = await call(`/api/join/${token}`, "POST", { name: "Anna", phone: "+1 555 000 2222" });
  assert.equal(join.status, 200);
  assert.equal(join.json.number, "+16289988199");
  assert.match(join.json.sms, /^sms:\+16289988199&body=ping/);
  assert.equal((await call("/api/join/not-a-token")).status, 404);

  // friend texts the line -> activated + welcomed
  await call("/api/dev/inbound", "POST", { handle: "+15550002222", kind: "text", text: "ping" });
  assert.equal(store.friends(store.currentHabit(store.getUserByPhone("+15404492120")!.id)!.id)[0].state, "active");

  // skip a week of virtual time
  await call("/api/dev/signal", "POST", { key: "app_minutes:Instagram", value: 140 });
  const week = await call("/api/dev/skip", "POST", { days: 7 });
  assert.ok(week.json.days.length >= 6, `expected >= 6 resolved days, got ${week.json.days.length}`);
  assert.ok(week.json.stats.done + week.json.stats.missed >= 6);

  // restart
  const re = await call("/api/habit/restart", "POST");
  assert.equal(re.json.habit?.status === "active", false);
});
