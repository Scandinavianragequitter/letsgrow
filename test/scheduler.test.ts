import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/engine/scheduler.js";
import { ScriptedLlm } from "./fake-llm.js";
import { FRIEND_PHONE, USER_PHONE, TZ, addActiveFriend, instagramPlan, setup, startHabit, stretchPlan, zonedTime } from "./helpers.js";
import { addDays } from "../src/clock.js";

const MIN = 60_000;
const MON = "2026-11-16"; // a Monday: autofilled calendar has Training 18:00-19:30

test("prompted: reminders anchor to calendar events, heart confirms, unconfirmed day is missed", async () => {
  const s = setup();
  const start = zonedTime(MON, "08:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, stretchPlan, start);
  await s.scheduler.tick(start);

  const rems = s.store.remindersForDay(habit.id, MON);
  assert.equal(rems.length, 2);
  assert.equal(rems[0].due_at, zonedTime(MON, "17:50", TZ)); // 10 min before training
  assert.equal(rems[1].due_at, zonedTime(MON, "19:35", TZ)); // 5 min after training

  // First reminder goes out, user taps a heart.
  await s.scheduler.tick(zonedTime(MON, "17:51", TZ));
  assert.equal(s.out(USER_PHONE).filter((m) => m.startsWith("Stretch")).length, 1);
  s.actions.logCompletion(s.user);
  assert.ok(s.store.remindersForDay(habit.id, MON)[0].confirmed_at);

  // Second reminder goes out, user ignores it. After the window the day is missed.
  await s.scheduler.tick(zonedTime(MON, "19:40", TZ));
  assert.equal(s.store.getDay(habit.id, MON), undefined);
  await s.scheduler.tick(zonedTime(MON, "21:40", TZ));
  const day = s.store.getDay(habit.id, MON)!;
  assert.equal(day.status, "missed");
  assert.equal(day.detail, "1/2 confirmed");
});

test("prompted: both confirmed means done; day without a training is not applicable", async () => {
  const s = setup();
  const start = zonedTime(MON, "08:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, stretchPlan, start);
  await s.scheduler.tick(start);
  for (const t of ["17:55", "19:40"]) {
    await s.scheduler.tick(zonedTime(MON, t, TZ));
    s.actions.logCompletion(s.user);
  }
  await s.scheduler.tick(zonedTime(MON, "23:00", TZ));
  assert.equal(s.store.getDay(habit.id, MON)!.status, "done");

  const tue = addDays(MON, 1); // only a lecture
  await s.scheduler.tick(zonedTime(tue, "00:30", TZ));
  assert.equal(s.store.getDay(habit.id, tue)!.status, "na");
});

test("missed day schedules a friend nudge after the grace delay, not before", async () => {
  const s = setup();
  const start = zonedTime(MON, "08:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, stretchPlan, start, "standard"); // 120 min grace
  await addActiveFriend(s, habit.id, start);
  await s.scheduler.tick(start);
  await s.scheduler.tick(zonedTime(MON, "17:55", TZ));
  await s.scheduler.tick(zonedTime(MON, "19:40", TZ));
  const missedAt = zonedTime(MON, "21:40", TZ);
  await s.scheduler.tick(missedAt);
  assert.equal(s.store.getDay(habit.id, MON)!.status, "missed");
  assert.equal(s.out(FRIEND_PHONE).filter((m) => m.includes("missed")).length, 0);

  await s.scheduler.tick(missedAt + 119 * MIN);
  assert.equal(s.store.friendEvents(habit.id).filter((e) => e.kind === "nudge").length, 0);
  await s.scheduler.tick(missedAt + 121 * MIN);
  assert.equal(s.store.friendEvents(habit.id).filter((e) => e.kind === "nudge").length, 1);
  assert.ok(s.out(FRIEND_PHONE).some((m) => m.includes("Carl") && m.includes("Stretch around training")));
});

test("autonomous: Screen Time is checked without asking the user anything", async () => {
  const s = setup(false);
  const start = zonedTime(MON, "09:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, instagramPlan, start);
  s.store.setSignal(s.user.id, MON, "app_minutes:Instagram", 95);
  await s.scheduler.tick(zonedTime(MON, "21:00", TZ));
  assert.equal(s.store.getDay(habit.id, MON), undefined); // not evaluated before 22:00
  await s.scheduler.tick(zonedTime(MON, "22:05", TZ));
  const d = s.store.getDay(habit.id, MON)!;
  assert.equal(d.status, "missed");
  assert.match(d.detail!, /95 min \(target <= 60 min\)/);
  assert.equal(s.out(USER_PHONE).length, 0); // the user was never messaged
});

test("autonomous: no data means unknown, never a false accusation", async () => {
  const s = setup(false);
  const start = zonedTime(MON, "09:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, instagramPlan, start);
  await s.scheduler.tick(zonedTime(MON, "22:05", TZ));
  assert.equal(s.store.getDay(habit.id, MON)!.status, "unknown");
  assert.equal(s.store.nudges(habit.id).length, 0);
});

test("two_in_a_row: a single miss stays private, the second tells the friend", async () => {
  const s = setup(false);
  const start = zonedTime(MON, "09:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, instagramPlan, start, "two_in_a_row");
  await addActiveFriend(s, habit.id, start);
  const d2 = addDays(MON, 1);
  s.store.setSignal(s.user.id, MON, "app_minutes:Instagram", 100);
  await s.scheduler.tick(zonedTime(MON, "22:05", TZ));
  await s.scheduler.tick(zonedTime(MON, "23:30", TZ));
  assert.equal(s.store.nudges(habit.id).length, 0);
  s.store.setSignal(s.user.id, d2, "app_minutes:Instagram", 100);
  await s.scheduler.tick(zonedTime(d2, "22:05", TZ));
  await s.scheduler.tick(zonedTime(d2, "23:30", TZ));
  assert.equal(s.store.nudges(habit.id).length, 1);
  assert.equal(s.store.friendEvents(habit.id).filter((e) => e.kind === "nudge").length, 1);
});

test("a done day breaks the miss streak", async () => {
  const s = setup(false);
  const start = zonedTime(MON, "09:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, instagramPlan, start, "two_in_a_row");
  const days = [MON, addDays(MON, 1), addDays(MON, 2), addDays(MON, 3)];
  const mins = [100, 30, 100, 100]; // miss, ok, miss, miss
  for (let i = 0; i < 4; i++) {
    s.store.setSignal(s.user.id, days[i], "app_minutes:Instagram", mins[i]);
    await s.scheduler.tick(zonedTime(days[i], "22:05", TZ));
  }
  assert.equal(s.store.nudges(habit.id).length, 1); // only after day 4 (two in a row)
  assert.equal(s.store.nudges(habit.id)[0].day, days[3]);
});

test("60 days resolves with a congrats to the user and a thank-you to the friend", async () => {
  const s = setup(false);
  const start = zonedTime(MON, "09:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, instagramPlan, start, "immediate", 60);
  const friend = await addActiveFriend(s, habit.id, start);
  let day = MON;
  for (let i = 0; i < 60; i++) {
    // misses on days 10 and 11, otherwise on target
    s.store.setSignal(s.user.id, day, "app_minutes:Instagram", i === 10 || i === 11 ? 120 : 40);
    await s.scheduler.tick(zonedTime(day, "22:05", TZ));
    await s.scheduler.tick(zonedTime(day, "23:59", TZ));
    if (i === 10) s.store.addFriendEvent(habit.id, friend.id, "support_reply", null, "You got this!", s.store.getHabit(habit.id)!.created_at);
    day = addDays(day, 1);
  }
  await s.scheduler.tick(zonedTime(day, "08:00", TZ));

  const h = s.store.getHabit(habit.id)!;
  assert.equal(h.status, "completed");
  assert.equal(s.store.days(habit.id).length, 60);
  const userMsgs = s.out(USER_PHONE);
  const congrats = userMsgs.find((m) => m.includes("60 days. You did it"));
  assert.ok(congrats, "user gets a congrats message");
  assert.match(congrats!, /58 of 60 days on target/);
  assert.match(congrats!, /Anna stepped in \d+ time/);
  const friendMsgs = s.out(FRIEND_PHONE);
  assert.ok(friendMsgs.some((m) => m.includes("just finished 60 days") && m.includes("replied 1 time")));
});

test("proactive messages are written by the agent when a model is available", async () => {
  const s = setup(false, new ScriptedLlm(() => ({ text: "Anna, Carl had a rough day. Want to send him a quick cheer?", toolCalls: [] })));
  const start = zonedTime(MON, "09:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, instagramPlan, start, "immediate", 60);
  await addActiveFriend(s, habit.id, start);
  const scheduler = new Scheduler({ store: s.store, integrations: s.integrations, messenger: s.messenger, publicBaseUrl: "http://x", write: (r) => s.agent.write(r) });
  s.store.setSignal(s.user.id, MON, "app_minutes:Instagram", 200);
  await scheduler.tick(zonedTime(MON, "22:05", TZ));
  await scheduler.tick(zonedTime(MON, "23:30", TZ));
  assert.deepEqual(s.out(FRIEND_PHONE), ["Anna, Carl had a rough day. Want to send him a quick cheer?"]);
});

test("completion is sent only once", async () => {
  const s = setup(false);
  const start = zonedTime(MON, "09:00", TZ);
  s.setNow(start);
  startHabit(s, instagramPlan, start, "immediate", 3);
  let day = MON;
  for (let i = 0; i < 3; i++) { s.store.setSignal(s.user.id, day, "app_minutes:Instagram", 30); await s.scheduler.tick(zonedTime(day, "22:05", TZ)); day = addDays(day, 1); }
  for (let i = 0; i < 4; i++) await s.scheduler.tick(zonedTime(day, `0${i + 1}:00`, TZ));
  assert.equal(s.out(USER_PHONE).filter((m) => m.includes("3 days. You did it")).length, 1);
});

test("a friend who was never needed doesn't learn the habit, even at the end", async () => {
  const s = setup(false);
  const start = zonedTime(MON, "09:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, instagramPlan, start, "immediate", 3);
  await addActiveFriend(s, habit.id, start);
  let day = MON;
  for (let i = 0; i < 3; i++) { s.store.setSignal(s.user.id, day, "app_minutes:Instagram", 30); await s.scheduler.tick(zonedTime(day, "22:05", TZ)); day = addDays(day, 1); }
  await s.scheduler.tick(zonedTime(day, "08:00", TZ));
  const all = s.out(FRIEND_PHONE);
  assert.equal(all.filter((m) => m.startsWith("[image ")).length, 1, "the friend gets the day-60 card");
  const final = all.filter((m) => !m.startsWith("[image "));
  assert.equal(final.length, 1);
  assert.match(final[0], /just finished 3 days of their new habit/);
  assert.ok(!final[0].includes(instagramPlan.title));
});
