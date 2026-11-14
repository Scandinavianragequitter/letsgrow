import type { Store, UserRow, HabitRow } from "../db.js";
import { HabitPlanSchema, type HabitPlan } from "../agent/plan.js";
import { dayKey } from "../clock.js";
import { policyFromPreset, policyFromSuggestion } from "../policy/escalation.js";

// State changes on a habit, shared by the agent's tools and the website buttons.
// Each one checks it is valid in the current state and says why not, so the agent can explain.

export const INVITE_TEXT = "Remind me if I'm late on my new healthy habit. Let's grow!";

export class HabitActions {
  constructor(private d: { store: Store; durationDays: number; publicBaseUrl: string; now: () => number }) {}

  inviteMessage(h: HabitRow) { return `${INVITE_TEXT} ${this.d.publicBaseUrl}/join/${h.invite_token}`; }

  savePlan(user: UserRow, plan: HabitPlan, description: string): HabitRow {
    const { store, now } = this.d;
    let habit = store.currentHabit(user.id);
    if (habit && habit.status !== "planning") throw new Error(`A habit is already ${habit.status}. Cancel it first to plan a new one.`);
    if (!habit) habit = store.createHabit(user.id, description, this.d.durationDays, JSON.stringify(policyFromPreset("standard")), now());
    store.setPlan(habit.id, JSON.stringify(HabitPlanSchema.parse(plan)), plan.title);
    store.setEscalation(habit.id, JSON.stringify(policyFromSuggestion(plan.suggestedMissedDaysBeforeFriendNudge)));
    return store.getHabit(habit.id)!;
  }

  start(user: UserRow): { habit: HabitRow; plan: HabitPlan; inviteMessage: string } {
    const { store, now } = this.d;
    const habit = store.currentHabit(user.id);
    if (!habit || habit.status !== "planning" || !habit.plan_json) throw new Error("There is no proposed plan to start yet.");
    store.activateHabit(habit.id, dayKey(now(), user.tz), now());
    const h = store.getHabit(habit.id)!;
    return { habit: h, plan: JSON.parse(h.plan_json!) as HabitPlan, inviteMessage: this.inviteMessage(h) };
  }

  cancel(user: UserRow) {
    const habit = this.d.store.currentHabit(user.id);
    if (!habit) throw new Error("There is no habit to cancel.");
    this.d.store.setHabitStatus(habit.id, "cancelled");
    return { cancelled: habit.description };
  }

  setFriendThreshold(user: UserRow, missedDays: number) {
    const habit = this.d.store.currentHabit(user.id);
    if (!habit) throw new Error("There is no habit yet.");
    const policy = policyFromSuggestion(missedDays);
    this.d.store.setEscalation(habit.id, JSON.stringify(policy));
    return policy;
  }

  /** Confirm a sent reminder. Without an id, the oldest one still waiting. */
  logCompletion(user: UserRow, reminderId?: number) {
    const { store, now } = this.d;
    const habit = store.currentHabit(user.id);
    if (!habit || habit.status !== "active") throw new Error("No habit is running.");
    const pending = store.pendingReminders(habit.id).sort((a, b) => (a.sent_at ?? 0) - (b.sent_at ?? 0));
    const r = reminderId !== undefined ? pending.find((x) => x.id === reminderId) : pending[0];
    if (!r) throw new Error(pending.length ? `Reminder ${reminderId} is not waiting for confirmation.` : "No reminder is waiting for confirmation right now.");
    const resolved = store.getDay(habit.id, r.day);
    if (resolved) throw new Error(`${r.day} was already counted as ${resolved.status}.`);
    store.confirmReminder(r.id, now());
    const sameDay = store.remindersForDay(habit.id, r.day);
    const open = sameDay.filter((x) => x.confirmed_at === null).length;
    return {
      confirmed: { id: r.id, day: r.day, text: r.text },
      remindersThatDay: sameDay.length,
      stillOpenThatDay: open,
      note: open === 0 ? "Every reminder that day is confirmed, so the day counts as done (the tally updates at the next check)." : undefined,
    };
  }
}
