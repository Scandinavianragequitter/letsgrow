import { test } from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/clock.js";
import { ConsoleAssigner } from "../src/messaging/assigner.js";
import { HabitActions } from "../src/engine/actions.js";
import { LoginCodes } from "../src/engine/login.js";
import { createApp } from "../src/web/server.js";
import { setup } from "./helpers.js";

function build() {
  const s = setup(true);
  const clock = new Clock(1);
  const login = new LoginCodes({ store: s.store, now: () => Date.now() });
  const app = createApp({ store: s.store, clock, agent: s.agent, actions: new HabitActions({ store: s.store, durationDays: 60, publicBaseUrl: "http://x", now: () => clock.now() }),
    scheduler: s.scheduler, messenger: s.messenger, assigner: new ConsoleAssigner("+16289988199"), devPanel: false, login });
  return { app, login, store: s.store };
}

test("live site: typing a number isn't enough; the code has to be texted from that phone", async () => {
  const { app, login } = build();
  const res = await app.request("/api/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Carl", phone: "+1 540 449 2120" }) });
  const body = await res.json() as any;
  assert.equal(res.headers.get("set-cookie"), null, "no session yet");
  assert.equal(body.user, null);
  const { ticket, code } = body.pending;
  assert.match(code, /^\d{4}$/);
  assert.match(body.pending.sms, new RegExp(`^sms:\\+16289988199&body=${code}$`));

  assert.equal((await (await app.request(`/api/login/${ticket}`)).json() as any).verified, false);
  assert.equal(login.verifyFromText("+15550009999", code), false, "someone else texting the code doesn't count");
  assert.equal(login.verifyFromText("+15404492120", "hi"), false);
  assert.equal(login.verifyFromText("+15404492120", `my code is ${code}`), true);

  const ok = await app.request(`/api/login/${ticket}`);
  assert.match(ok.headers.get("set-cookie") ?? "", /lg_session=/);
  assert.equal((await ok.json() as any).user.name, "Carl");
  assert.equal(((await (await app.request(`/api/login/${ticket}`)).json()) as any).verified, false, "a ticket works once");
});

test("sign-ups are rate limited per phone number", async () => {
  const { app } = build();
  let last = 0;
  for (let i = 0; i < 8; i++) {
    last = (await app.request("/api/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "X", phone: "+1 555 000 7777" }) })).status;
  }
  assert.equal(last, 429);
});
