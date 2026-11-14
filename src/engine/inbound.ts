import type { Store } from "../db.js";
import type { HabitPlan } from "../agent/plan.js";
import type { InboundEvent, Messenger } from "../messaging/messenger.js";
import { msg } from "./messages.js";

const HEARTS = new Set(["❤️", "❤", "♥️", "💕", "💖", "😍", "love", "heart", "👍", "✅"]);
const DONE = /^(done|did it|yes|yep|y|✅|👍|❤️|❤|finished|check)[.! ]*$/i;

/** Routes inbound texts/tapbacks: user confirmations and friend replies. */
export class InboundRouter {
  constructor(private store: Store, private messenger: Messenger, private now: () => number) {}

  async handle(e: InboundEvent): Promise<void> {
    const now = this.now();
    const { store, messenger } = this;

    // A friend who was assigned but has not texted yet: this first text activates them.
    const friendRows = store.friendsByPhone(e.handle)
      .filter((f) => store.getHabit(f.habit_id)?.status === "active");
    const fresh = friendRows.find((f) => f.state === "assigned");
    if (fresh) {
      const habit = store.getHabit(fresh.habit_id)!;
      const user = store.getUser(habit.user_id)!;
      const plan = JSON.parse(habit.plan_json!) as HabitPlan;
      store.activateFriend(fresh.id, now);
      store.addFriendEvent(habit.id, fresh.id, "joined", null, null, now);
      await messenger.send(e.handle, msg.friendWelcome(fresh.name, user.name, plan.title, habit.duration_days));
      return;
    }

    const user = store.getUserByPhone(e.handle);
    if (user) {
      const first = !user.connected;
      store.markUserConnected(user.id);
      const habit = store.currentHabit(user.id);
      const plan = habit?.plan_json ? (JSON.parse(habit.plan_json) as HabitPlan) : undefined;
      if (first) {
        await messenger.send(e.handle, msg.userConnected(user.name, plan?.title ?? "your habit"));
        return;
      }
      if (!habit || habit.status !== "active" || !plan) return;
      const isConfirm =
        (e.kind === "reaction" && !!e.emoji && HEARTS.has(e.emoji)) ||
        (e.kind === "text" && !!e.text && DONE.test(e.text.trim()));
      if (isConfirm) {
        const r = store.oldestPendingReminder(habit.id);
        if (r) {
          store.confirmReminder(r.id, now);
          if (e.kind === "text") await messenger.send(e.handle, msg.userAck);
        }
        return;
      }
      if (e.kind === "text") {
        await messenger.send(e.handle, plan.mode === "autonomous" ? msg.userAutoTracked : msg.userHowTo);
      }
      return;
    }

    const friend = friendRows[0];
    if (friend && friend.state === "active") {
      const habit = store.getHabit(friend.habit_id)!;
      const owner = store.getUser(habit.user_id)!;
      const body = e.kind === "text" ? (e.text ?? "") : (e.emoji ?? "");
      if (!body) return;
      store.addFriendEvent(habit.id, friend.id, "support_reply", null, body, now);
      if (e.kind === "text") await messenger.send(e.handle, msg.friendThanks(owner.name));
      await messenger.send(owner.phone, e.kind === "text" ? msg.relayToUser(friend.name, body) : msg.relayReactionToUser(friend.name, body));
    }
  }
}
