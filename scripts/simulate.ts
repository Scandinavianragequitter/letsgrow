// Simulate a whole habit in seconds and print what each person would see.
//   npm run simulate                    -> Instagram habit, "standard" escalation
//   npm run simulate -- stretch gentle  -> stretching habit, "gentle" escalation
import { Store } from "../src/db.js";
import { MockIntegrations } from "../src/integrations/mock.js";
import { ConsoleMessenger } from "../src/messaging/messenger.js";
import { Scheduler } from "../src/engine/scheduler.js";
import { InboundRouter } from "../src/engine/inbound.js";
import { HabitPlanSchema } from "../src/agent/plan.js";
import { PRESETS, policyFromPreset } from "../src/policy/escalation.js";
import { addDays, dayKey, zonedTime } from "../src/clock.js";
import { computeStats } from "../src/engine/stats.js";

const kind = process.argv[2] === "stretch" ? "stretch" : "instagram";
const preset = process.argv[3] && PRESETS[process.argv[3]] ? process.argv[3] : "standard";
const TZ = "America/New_York", ME = "+15404492120", FRIEND = "+15550002222";

const plan = HabitPlanSchema.parse(kind === "stretch" ? {
  title: "Stretch around training", summary: "Demo plan.", mode: "prompted",
  prompted: { reminders: [
    { anchor: "calendar_event", eventKeyword: "training", edge: "start", offsetMinutes: -10, text: "Stretch for 10 min before training. React ❤️ when done." },
    { anchor: "calendar_event", eventKeyword: "training", edge: "end", offsetMinutes: 5, text: "Stretch for 5 min. React ❤️ when done." },
  ], confirmWith: "heart", confirmWithinMinutes: 120 },
  suggestedMissedDaysBeforeFriendNudge: 1,
} : {
  title: "Under 1h of Instagram a day", summary: "Demo plan.", mode: "autonomous",
  autonomous: { source: "screen_time", metric: "app_minutes:Instagram", comparator: "lte", threshold: 60, unit: "min", evaluateAt: "22:00" },
  suggestedMissedDaysBeforeFriendNudge: 1,
});

const store = new Store(":memory:");
let now = 0;
const messenger = new ConsoleMessenger(store, () => now);
const scheduler = new Scheduler({ store, integrations: new MockIntegrations(store, true), messenger, publicBaseUrl: "http://localhost:3000" });
const router = new InboundRouter(store, messenger, () => now);
await messenger.start((e) => router.handle(e));

const user = store.createUser("Carl", ME, TZ, 0);
store.markUserConnected(user.id);
const startDay = "2026-11-16";
now = zonedTime(startDay, "08:00", TZ);
const habit = store.createHabit(user.id, plan.title, 60, JSON.stringify(policyFromPreset(preset)), now);
store.setPlan(habit.id, JSON.stringify(plan), plan.title);
store.activateHabit(habit.id, startDay, now);
store.addFriend(habit.id, "Anna", FRIEND, "+16289988199", now);
await router.handle({ handle: FRIEND, kind: "text", text: "ping" });

let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
let day = startDay;
console.log(`\n=== ${plan.title} | escalation: ${PRESETS[preset].label} ===\n`);
for (let i = 0; i < 61; i++) {
  for (let h = 0; h < 24; h++) {
    now = zonedTime(day, "00:00", TZ) + h * 3_600_000 + 5 * 60_000;
    await scheduler.tick(now);
    // the user taps a heart ~70% of the time, shortly after a reminder arrives
    if (kind === "stretch" && store.pendingReminders(habit.id).length && rnd() < 0.7) {
      await router.handle({ handle: ME, kind: "reaction", emoji: "❤️" });
    }
    // Anna replies to about half of the nudges she gets
    const fe = store.friendEvents(habit.id).filter((e) => e.kind === "nudge").length;
    const replied = store.friendEvents(habit.id).filter((e) => e.kind === "support_reply").length;
    if (fe > replied && rnd() < 0.5) await router.handle({ handle: FRIEND, kind: "text", text: "Hey, you've got this! Go stretch 💪" });
  }
  day = addDays(day, 1);
}

const sym = { done: "█", missed: "x", na: "·", unknown: "?" } as const;
const days = store.days(habit.id);
console.log("Timeline (█ done, x missed, · not applicable):");
for (let i = 0; i < days.length; i += 30) console.log("  " + days.slice(i, i + 30).map((d) => sym[d.status]).join(""));
const st = computeStats(store, habit);
console.log(`\n${st.done} on target, ${st.missed} missed, best streak ${st.longestStreak}`);
console.log(`Friend nudges: ${store.friendEvents(habit.id).filter((e) => e.kind === "nudge").length}, replies: ${store.friendEvents(habit.id).filter((e) => e.kind === "support_reply").length}`);
console.log(`Habit status: ${store.getHabit(habit.id)!.status}\n`);
const log = store.recentMessages(10_000).filter((m) => m.direction === "out");
const show = (who: string, name: string, re: RegExp) => log.filter((m) => m.handle === who && re.test(m.body)).slice(-1).forEach((m) => console.log(`${name} got:\n  "${m.body}"\n`));
show(FRIEND, "Anna (first nudge)", /missed|behind|slipped/);
show(FRIEND, "Anna (finale)", /just finished/);
show(ME, "Carl (finale)", /You did it/);
