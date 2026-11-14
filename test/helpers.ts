import { Store } from "../src/db.js";
import { MockIntegrations } from "../src/integrations/mock.js";
import { ConsoleMessenger } from "../src/messaging/messenger.js";
import { Scheduler } from "../src/engine/scheduler.js";
import { InboundRouter } from "../src/engine/inbound.js";
import { HabitPlanSchema, type HabitPlan } from "../src/agent/plan.js";
import { policyFromPreset } from "../src/policy/escalation.js";
import { dayKey, zonedTime } from "../src/clock.js";

export const TZ = "America/New_York";
export const USER_PHONE = "+15550001111";
export const FRIEND_PHONE = "+15550002222";

export function setup(autofill = true) {
  const store = new Store(":memory:");
  let nowMs = 0;
  const messenger = new ConsoleMessenger(store, () => nowMs);
  const integrations = new MockIntegrations(store, autofill);
  const scheduler = new Scheduler({ store, integrations, messenger, publicBaseUrl: "http://localhost:3000" });
  const router = new InboundRouter(store, messenger, () => nowMs);
  void messenger.start((e) => router.handle(e));
  const user = store.createUser("Carl", USER_PHONE, TZ, 0);
  store.markUserConnected(user.id);
  return {
    store, messenger, scheduler, router, integrations, user,
    setNow: (ms: number) => { nowMs = ms; },
    out: (to?: string) => store.recentMessages(500).filter((m) => m.direction === "out" && (!to || m.handle === to)).map((m) => m.body),
  };
}

export const stretchPlan: HabitPlan = HabitPlanSchema.parse({
  title: "Stretch around training",
  summary: "I'll remind you around training.",
  mode: "prompted",
  prompted: {
    reminders: [
      { anchor: "calendar_event", eventKeyword: "training", edge: "start", offsetMinutes: -10, text: "Stretch for 10 min. React ❤️ when done." },
      { anchor: "calendar_event", eventKeyword: "training", edge: "end", offsetMinutes: 5, text: "Stretch for 5 min. React ❤️ when done." },
    ],
    confirmWith: "heart", confirmWithinMinutes: 120,
  },
  suggestedMissedDaysBeforeFriendNudge: 1,
});

export const instagramPlan: HabitPlan = HabitPlanSchema.parse({
  title: "Less Instagram",
  summary: "I'll check Screen Time each evening.",
  mode: "autonomous",
  autonomous: { source: "screen_time", metric: "app_minutes:Instagram", comparator: "lte", threshold: 60, unit: "min", evaluateAt: "22:00" },
  suggestedMissedDaysBeforeFriendNudge: 2,
});

export function startHabit(
  s: ReturnType<typeof setup>, plan: HabitPlan, startAtMs: number,
  preset: "immediate" | "standard" | "two_in_a_row" | "gentle" = "standard", durationDays = 60,
) {
  const habit = s.store.createHabit(s.user.id, plan.title, durationDays, JSON.stringify(policyFromPreset(preset)), startAtMs);
  s.store.setPlan(habit.id, JSON.stringify(plan), plan.title);
  s.store.activateHabit(habit.id, dayKey(startAtMs, TZ), startAtMs);
  return s.store.getHabit(habit.id)!;
}

export async function addActiveFriend(s: ReturnType<typeof setup>, habitId: string, now: number) {
  const f = s.store.addFriend(habitId, "Anna", FRIEND_PHONE, "+16289988199", now);
  await s.router.handle({ handle: FRIEND_PHONE, kind: "text", text: "ping" });
  return f;
}

export { zonedTime, dayKey };
