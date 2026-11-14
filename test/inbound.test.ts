import { test } from "node:test";
import assert from "node:assert/strict";
import { FRIEND_PHONE, USER_PHONE, TZ, instagramPlan, setup, startHabit, stretchPlan, zonedTime } from "./helpers.js";

const MON = "2026-11-16";

test("a friend's first text activates them and gets a welcome; later texts count as support", async () => {
  const s = setup(false);
  const start = zonedTime(MON, "09:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, instagramPlan, start);
  s.store.addFriend(habit.id, "Anna", FRIEND_PHONE, "+16289988199", start);
  assert.equal(s.store.friends(habit.id)[0].state, "assigned");
  await s.router.handle({ handle: FRIEND_PHONE, kind: "text", text: "ping" });
  assert.equal(s.store.friends(habit.id)[0].state, "active");
  assert.match(s.out(FRIEND_PHONE)[0], /accountability buddy for "Less Instagram"/);
  await s.router.handle({ handle: FRIEND_PHONE, kind: "reaction", emoji: "❤️" });
  assert.equal(s.store.friendEvents(habit.id).filter((e) => e.kind === "support_reply").length, 1);
  assert.ok(s.out(USER_PHONE).some((m) => m.includes("Anna sent you a")));
});

test("the user's first text connects them", async () => {
  const s = setup(false);
  s.store.db.prepare("UPDATE users SET connected=0 WHERE id=?").run(s.user.id);
  await s.router.handle({ handle: USER_PHONE, kind: "text", text: "hi" });
  assert.equal(s.store.getUser(s.user.id)!.connected, 1);
  assert.match(s.out(USER_PHONE)[0], /you're connected/);
});

test("a heart confirms the oldest pending reminder only", async () => {
  const s = setup();
  const start = zonedTime(MON, "08:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, stretchPlan, start);
  await s.scheduler.tick(start);
  await s.scheduler.tick(zonedTime(MON, "20:00", TZ)); // both reminders sent
  await s.router.handle({ handle: USER_PHONE, kind: "reaction", emoji: "❤️" });
  const r = s.store.remindersForDay(habit.id, MON);
  assert.ok(r[0].confirmed_at);
  assert.equal(r[1].confirmed_at, null);
});

test("on an autonomous habit the user is told nothing needs reporting", async () => {
  const s = setup(false);
  const start = zonedTime(MON, "09:00", TZ);
  s.setNow(start);
  startHabit(s, instagramPlan, start);
  await s.router.handle({ handle: USER_PHONE, kind: "text", text: "how am I doing?" });
  assert.match(s.out(USER_PHONE)[0], /tracking this one automatically/);
});
