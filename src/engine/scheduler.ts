import type { Store, HabitRow, UserRow, FriendRow } from "../db.js";
import type { HabitPlan } from "../agent/plan.js";
import type { Integrations } from "../integrations/mock.js";
import type { Messenger } from "../messaging/messenger.js";
import { addDays, dayKey, zonedTime } from "../clock.js";
import { decideNudge, type EscalationPolicy } from "../policy/escalation.js";
import { appliesToDay, evaluateAutonomous } from "./verifier.js";
import { computeStats, friendHelp, trailingMisses } from "./stats.js";
import { msg } from "./messages.js";
import { renderCard, type CardData } from "./card.js";

const MIN = 60_000;

export interface WriteRequest { to: string; purpose: string; facts: Record<string, unknown>; fallback: string }

export interface SchedulerDeps {
  store: Store;
  integrations: Integrations;
  messenger: Messenger;
  publicBaseUrl: string;
  /** Lets the agent word proactive messages. Without it, the fallback text is sent. */
  write?: (req: WriteRequest) => Promise<string>;
}

/**
 * One tick = "what should happen as of `now`". Pure with respect to time (now is a parameter),
 * so the dev panel, the real loop and the tests all drive the same code.
 */
export class Scheduler {
  constructor(private d: SchedulerDeps) {}

  private say(req: WriteRequest): Promise<string> {
    return this.d.write ? this.d.write(req) : Promise.resolve(req.fallback);
  }

  async tick(now: number): Promise<void> {
    for (const habit of this.d.store.activeHabits()) {
      try { await this.tickHabit(habit, now); }
      catch (err) { console.error(`tick failed for ${habit.id}:`, err); }
    }
  }

  private async tickHabit(h: HabitRow, now: number) {
    const { store } = this.d;
    if (!h.plan_json || !h.start_day) return;
    const user = store.getUser(h.user_id)!;
    const plan = JSON.parse(h.plan_json) as HabitPlan;
    const policy = JSON.parse(h.escalation_json) as EscalationPolicy;
    const today = dayKey(now, user.tz);
    if (today < h.start_day) return;
    const finalDay = addDays(h.start_day, h.duration_days - 1);
    const lastDay = today < finalDay ? today : finalDay;

    // 1. Plan each day's reminders (prompted habits).
    if (plan.mode === "prompted") {
      for (let day = h.start_day; day <= lastDay; day = addDays(day, 1)) {
        if (store.hasMaterialized(h.id, day)) continue;
        if (day === today) this.materialize(h, plan, user, day, now);
        else {
          // The agent was not running on that day, so there is nothing to verify.
          store.markMaterialized(h.id, day);
          if (!store.getDay(h.id, day)) store.setDay(h.id, day, "unknown", "agent was offline", now);
        }
      }
    }

    // 2. Send reminders that are due.
    await this.sendDueReminders(h, user, now);

    // 3. Resolve finished days, in order.
    for (let day = h.start_day; day <= lastDay; day = addDays(day, 1)) {
      if (store.getDay(h.id, day)) continue;
      const res = this.resolveDay(h, plan, user, day, now);
      if (!res) continue;
      store.setDay(h.id, day, res.status, res.detail, now);
      if (res.status === "missed") this.onMiss(h, policy, day, now);
    }

    // 4. Tell friends when a scheduled nudge is due.
    await this.sendDueNudges(h, user, now);

    // 5. Finish line.
    const all = store.days(h.id);
    if (all.length >= h.duration_days && today > finalDay) await this.complete(h, user, now);
  }

  private materialize(h: HabitRow, plan: HabitPlan, user: UserRow, day: string, now: number) {
    const { store, integrations } = this.d;
    store.markMaterialized(h.id, day);
    if (!appliesToDay(plan, day) || !plan.prompted) return;
    const window = plan.prompted.confirmWithinMinutes * MIN;
    for (const r of plan.prompted.reminders) {
      const dues: number[] = [];
      if (r.anchor === "fixed_time" && r.time) dues.push(zonedTime(day, r.time, user.tz));
      if (r.anchor === "calendar_event" && r.eventKeyword) {
        const kw = r.eventKeyword.toLowerCase();
        for (const e of integrations.events(user.id, day, user.tz)) {
          if (!e.title.toLowerCase().includes(kw)) continue;
          dues.push((r.edge === "end" ? e.endMs : e.startMs) + (r.offsetMinutes ?? 0) * MIN);
        }
      }
      for (const due of dues) {
        if (due < now - 10 * MIN) continue; // too late to be useful (e.g. habit started mid-day)
        store.addReminder({ habit_id: h.id, day, due_at: due, text: r.text, deadline_at: due + window });
      }
    }
  }

  private async sendDueReminders(h: HabitRow, user: UserRow, now: number) {
    const { store, messenger } = this.d;
    if (messenger.mode === "photon" && !user.connected) return; // shared line cannot text first
    for (const r of store.dueUnsentReminders(h.id, now)) {
      try {
        await messenger.send(user.phone, r.text);
        store.markReminderSent(r.id, now);
      } catch (err) { console.warn(`reminder ${r.id} not sent:`, (err as Error).message); }
    }
  }

  private resolveDay(h: HabitRow, plan: HabitPlan, user: UserRow, day: string, now: number) {
    const { store, integrations } = this.d;
    if (!appliesToDay(plan, day)) return { status: "na" as const, detail: "not a tracked day" };

    if (plan.mode === "autonomous") {
      const at = zonedTime(day, plan.autonomous?.evaluateAt ?? "22:00", user.tz);
      if (now < at) return null;
      return evaluateAutonomous(plan, integrations, user.id, day);
    }

    const rems = store.remindersForDay(h.id, day);
    if (!store.hasMaterialized(h.id, day)) return null;
    if (rems.length === 0) return { status: "na" as const, detail: "nothing to do today" };
    const confirmed = rems.filter((r) => r.confirmed_at !== null).length;
    if (confirmed === rems.length) return { status: "done" as const, detail: `${confirmed}/${rems.length} confirmed` };
    const lastDeadline = Math.max(...rems.filter((r) => r.confirmed_at === null).map((r) => r.deadline_at));
    if (now > lastDeadline) return { status: "missed" as const, detail: `${confirmed}/${rems.length} confirmed` };
    return null;
  }

  private onMiss(h: HabitRow, policy: EscalationPolicy, day: string, now: number) {
    const { store } = this.d;
    const streak = trailingMisses(store.days(h.id).map((d) => d.status));
    const times = store.nudges(h.id).map((n) => n.sent_at ?? n.send_at);
    const decision = decideNudge(policy, { consecutiveMisses: streak, nudgeTimes: times, now });
    if (decision.nudge && decision.sendAt !== undefined) {
      store.addPendingNudge(h.id, day, decision.sendAt, `${decision.reason}`);
    }
  }

  private activeFriends(habitId: string): FriendRow[] {
    return this.d.store.friends(habitId).filter((f) => f.state === "active");
  }

  private async sendDueNudges(h: HabitRow, user: UserRow, now: number) {
    const { store, messenger, publicBaseUrl } = this.d;
    for (const n of store.dueNudges(h.id, now)) {
      const friends = this.activeFriends(h.id);
      const streak = trailingMisses(store.days(h.id).filter((d) => d.day <= n.day).map((d) => d.status));
      const title = (JSON.parse(h.plan_json!) as HabitPlan).title;
      if (friends.length === 0) {
        const url = `${publicBaseUrl}/join/${h.invite_token}`;
        try {
          await messenger.send(user.phone, await this.say({
            to: user.name,
            purpose: "They missed their habit and the policy says a friend should be asked to step in, but no friend has joined yet. Encourage them briefly and ask them to send a friend their invite link.",
            facts: { habit: title, consecutiveMissedDays: streak, inviteLink: url },
            fallback: msg.noFriendYet(url),
          }));
        } catch { /* ignore */ }
      }
      for (const f of friends) {
        try {
          const idx = store.friendEvents(h.id).filter((e) => e.friend_id === f.id && e.kind === "nudge").length;
          await messenger.send(f.phone, await this.say({
            to: f.name,
            purpose: `${user.name} slipped on their habit. Ask ${f.name} to send ${user.name} a short word of support by replying here (you will pass it on). Do not shame ${user.name}.`,
            facts: { friend: f.name, person: user.name, habit: title, consecutiveMissedDays: streak, timesAskedBefore: idx },
            fallback: msg.friendNudge(f.name, user.name, title, streak, idx),
          }));
          store.addFriendEvent(h.id, f.id, "nudge", n.day, null, now);
        } catch (err) { console.warn(`nudge to ${f.id} failed:`, (err as Error).message); }
      }
      store.markNudgeSent(n.id, now);
    }
  }

  private async complete(h: HabitRow, user: UserRow, now: number) {
    const { store, messenger } = this.d;
    const plan = JSON.parse(h.plan_json!) as HabitPlan;
    const stats = computeStats(store, h);
    const help = friendHelp(store, h.id);
    const friends = store.friends(h.id).filter((f) => f.state === "active");
    const totalNudges = [...help.values()].reduce((a, b) => a + b.nudges, 0);
    const totalReplies = [...help.values()].reduce((a, b) => a + b.replies, 0);

    const friendLine = friends.length === 0
      ? ""
      : totalNudges === 0
        ? `${friends.map((f) => f.name).join(" and ")} never even had to step in.`
        : `${friends.map((f) => f.name).join(" and ")} stepped in ${totalNudges} time${totalNudges === 1 ? "" : "s"} and sent ${totalReplies} message${totalReplies === 1 ? "" : "s"} of support.`;

    store.setHabitStatus(h.id, "completed", now);
    const statuses = store.days(h.id).map((d) => d.status);
    const card = (c: Omit<CardData, "days" | "done" | "counted" | "longestStreak" | "statuses">) =>
      renderCard({ days: h.duration_days, done: stats.done, counted: stats.counted, longestStreak: stats.longestStreak, statuses, ...c });
    const sendCard = async (to: string, c: Parameters<typeof card>[0]) => {
      if (!messenger.sendImage) return;
      try { await messenger.sendImage(to, card(c)); } catch (err) { console.warn("day-60 card not sent:", (err as Error).message); }
    };
    await sendCard(user.phone, { title: `“${plan.title}”`, footer: friends.length ? `With ${friends.map((f) => f.name).join(" and ")}` : "All you." });
    try {
      await messenger.send(user.phone, await this.say({
        to: user.name,
        purpose: "They finished the full habit period. Congratulate them on their personal growth, mention how they did, and credit their friends.",
        facts: { habit: plan.title, days: h.duration_days, daysOnTarget: stats.done, daysCounted: stats.counted, longestStreak: stats.longestStreak,
          friends: friends.map((f) => ({ name: f.name, ...(help.get(f.id) ?? { nudges: 0, replies: 0 }) })) },
        fallback: msg.userCongrats(user.name, plan.title, h.duration_days, stats.done, stats.counted, stats.longestStreak, friendLine),
      }));
    } catch (err) { console.warn("congrats to user failed:", (err as Error).message); }
    for (const f of friends) {
      const r = help.get(f.id) ?? { nudges: 0, replies: 0 };
      await sendCard(f.phone, friendCardText(user.name, plan.title, r.nudges));
      try {
        await messenger.send(f.phone, await this.say({
          to: f.name,
          purpose: `${user.name} finished their habit. Thank ${f.name}, tell them how often they helped, and that ${user.name} grew.`
            + (r.nudges === 0 ? ` ${f.name} was never needed, so ${user.name}'s habit stays private: don't guess or hint at what it was.` : ""),
          // The habit stays private from a friend who was never needed.
          facts: { person: user.name, ...(r.nudges > 0 ? { habit: plan.title } : {}), days: h.duration_days, timesAskedToHelp: r.nudges, timesReplied: r.replies, daysOnTarget: stats.done, daysCounted: stats.counted },
          fallback: msg.friendCongrats(f.name, user.name, r.nudges > 0 ? plan.title : null, h.duration_days, r.nudges, r.replies),
        }));
        store.addFriendEvent(h.id, f.id, "final", null, null, now);
      } catch (err) { console.warn(`final message to ${f.id} failed:`, (err as Error).message); }
    }
  }
}

/** A friend who was never needed doesn't learn the habit, on the card either. */
export function friendCardText(person: string, habit: string, nudges: number) {
  return nudges > 0
    ? { title: `${person}: “${habit}”`, footer: `You stepped in ${nudges} time${nudges === 1 ? "" : "s"}. Part of this is yours.` }
    : { title: `${person}’s new habit.`, footer: `${person} never needed a nudge. Knowing you were there helped.` };
}
