import type { Store, UserRow } from "../db.js";
import type { Planner } from "../agent/planner.js";
import type { HabitPlan } from "../agent/plan.js";
import { dayKey } from "../clock.js";
import { policyFromPreset, policyFromSuggestion } from "../policy/escalation.js";

/** Planning a habit, shared by the website chat and the iMessage thread (one chat history for both). */
export class Planning {
  constructor(private d: { store: Store; planner: Planner; durationDays: number; now: () => number }) {}

  /** One planner turn. Returns the agent's reply and the plan if it proposed one. */
  async turn(user: UserRow, text: string): Promise<{ reply: string; plan?: HabitPlan }> {
    const { store, planner, now } = this.d;
    let habit = store.currentHabit(user.id);
    if (habit && habit.status !== "planning") throw new Error("You already have a habit running. Start over to plan a new one.");
    if (!habit) habit = store.createHabit(user.id, text, this.d.durationDays, JSON.stringify(policyFromPreset("standard")), now());
    const history = store.chat(user.id).map((m) => ({ role: m.role, content: m.content }));
    const turn = await planner.turn(user.name, history, text);
    store.addChat(user.id, "user", text, now());
    store.addChat(user.id, "assistant", turn.reply, now());
    if (turn.plan) {
      store.setPlan(habit.id, JSON.stringify(turn.plan), turn.plan.title);
      store.setEscalation(habit.id, JSON.stringify(policyFromSuggestion(turn.plan.suggestedMissedDaysBeforeFriendNudge)));
    }
    return { reply: turn.reply, plan: turn.plan };
  }

  /** Start the planned habit today. Returns undefined if there is no plan to start. */
  start(user: UserRow): { title: string; days: number; inviteToken: string } | undefined {
    const { store, now } = this.d;
    const habit = store.currentHabit(user.id);
    if (!habit || habit.status !== "planning" || !habit.plan_json) return undefined;
    store.activateHabit(habit.id, dayKey(now(), user.tz), now());
    const plan = JSON.parse(habit.plan_json) as HabitPlan;
    return { title: plan.title, days: habit.duration_days, inviteToken: habit.invite_token };
  }
}
