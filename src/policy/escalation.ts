// How fast does the friend's agent tell on you? Everything tunable lives here.
// A policy is stored per habit (JSON), so it can be changed any time from the UI/API.

export interface EscalationPolicy {
  /** Tell the friend once you have missed this many days in a row. 1 = first miss. */
  missedDaysBeforeNudge: number;
  /** Minutes to wait after the miss is detected before the friend is texted (lets you catch up first). */
  delayMinutesAfterMiss: number;
  /** While the streak continues, nudge again every N additional missed days. 0 = only once per streak. */
  repeatEveryMissedDays: number;
  /** Hard cap so friends are not spammed. */
  maxNudgesPerWeek: number;
  /** Minimum gap between two nudges. */
  minHoursBetweenNudges: number;
}

export const PRESETS: Record<string, EscalationPolicy & { label: string }> = {
  immediate: {
    label: "Right away (first miss)",
    missedDaysBeforeNudge: 1, delayMinutesAfterMiss: 0, repeatEveryMissedDays: 1,
    maxNudgesPerWeek: 5, minHoursBetweenNudges: 12,
  },
  standard: {
    label: "Standard (first miss, after a 2h grace)",
    missedDaysBeforeNudge: 1, delayMinutesAfterMiss: 120, repeatEveryMissedDays: 2,
    maxNudgesPerWeek: 3, minHoursBetweenNudges: 24,
  },
  two_in_a_row: {
    label: "Only after two misses in a row",
    missedDaysBeforeNudge: 2, delayMinutesAfterMiss: 60, repeatEveryMissedDays: 2,
    maxNudgesPerWeek: 2, minHoursBetweenNudges: 24,
  },
  gentle: {
    label: "Gentle (three misses in a row)",
    missedDaysBeforeNudge: 3, delayMinutesAfterMiss: 120, repeatEveryMissedDays: 0,
    maxNudgesPerWeek: 1, minHoursBetweenNudges: 48,
  },
};

export const DEFAULT_PRESET = "standard";

export function policyFromPreset(name: string): EscalationPolicy {
  const { label: _label, ...p } = PRESETS[name] ?? PRESETS[DEFAULT_PRESET];
  return { ...p };
}

/** Planner suggestion (consecutive misses before telling) -> a concrete policy. */
export function policyFromSuggestion(missedDays: number): EscalationPolicy {
  if (missedDays <= 1) return policyFromPreset("standard");
  if (missedDays === 2) return policyFromPreset("two_in_a_row");
  return { ...policyFromPreset("gentle"), missedDaysBeforeNudge: missedDays };
}

export interface NudgeContext {
  /** Trailing missed days in a row, including the day just resolved. */
  consecutiveMisses: number;
  /** Timestamps (virtual ms) of nudges already sent for this habit. */
  nudgeTimes: number[];
  now: number;
}

export interface NudgeDecision {
  nudge: boolean;
  reason: string;
  /** Virtual ms at which to send, when nudge is true. */
  sendAt?: number;
}

const HOUR = 3_600_000;

/** Pure decision function: easy to unit test and to tweak. */
export function decideNudge(policy: EscalationPolicy, ctx: NudgeContext): NudgeDecision {
  const { consecutiveMisses: n } = ctx;
  if (n < policy.missedDaysBeforeNudge) {
    return { nudge: false, reason: `streak ${n} < threshold ${policy.missedDaysBeforeNudge}` };
  }
  const over = n - policy.missedDaysBeforeNudge;
  const onCadence =
    over === 0 || (policy.repeatEveryMissedDays > 0 && over % policy.repeatEveryMissedDays === 0);
  if (!onCadence) return { nudge: false, reason: "between repeat nudges" };

  const weekAgo = ctx.now - 7 * 24 * HOUR;
  if (ctx.nudgeTimes.filter((t) => t >= weekAgo).length >= policy.maxNudgesPerWeek) {
    return { nudge: false, reason: "weekly nudge cap reached" };
  }
  const last = ctx.nudgeTimes.length ? Math.max(...ctx.nudgeTimes) : -Infinity;
  if (ctx.now - last < policy.minHoursBetweenNudges * HOUR) {
    return { nudge: false, reason: "too soon after the last nudge" };
  }
  return { nudge: true, reason: `${n} missed in a row`, sendAt: ctx.now + policy.delayMinutesAfterMiss * 60_000 };
}
