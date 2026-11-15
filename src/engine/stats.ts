import type { Store, HabitRow } from "../db.js";

export interface HabitStats {
  done: number; missed: number; na: number; unknown: number; counted: number;
  longestStreak: number; currentMissStreak: number;
}

export function computeStats(store: Store, habit: HabitRow): HabitStats {
  const days = store.days(habit.id);
  let done = 0, missed = 0, na = 0, unknown = 0, longest = 0, run = 0;
  for (const d of days) {
    if (d.status === "done") { done++; run++; longest = Math.max(longest, run); }
    else if (d.status === "missed") { missed++; run = 0; }
    else if (d.status === "na") na++;
    else unknown++;
  }
  return { done, missed, na, unknown, counted: done + missed, longestStreak: longest, currentMissStreak: trailingMisses(days.map((d) => d.status)) };
}

/** Trailing missed days; days that did not apply (na) or had no data (unknown) neither count nor break it. */
export function trailingMisses(statuses: string[]): number {
  let n = 0;
  for (let i = statuses.length - 1; i >= 0; i--) {
    const s = statuses[i];
    if (s === "missed") n++;
    else if (s === "done") break;
  }
  return n;
}

export function friendHelp(store: Store, habitId: string) {
  const events = store.friendEvents(habitId);
  const by = new Map<string, { nudges: number }>();
  for (const e of events) {
    const r = by.get(e.friend_id) ?? { nudges: 0 };
    if (e.kind === "nudge") r.nudges++;
    by.set(e.friend_id, r);
  }
  return by;
}
