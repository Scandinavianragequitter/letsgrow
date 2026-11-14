import type { HabitPlan } from "../agent/plan.js";
import type { DayStatus } from "../db.js";
import type { Integrations } from "../integrations/mock.js";
import { weekday } from "../clock.js";

export function appliesToDay(plan: HabitPlan, day: string): boolean {
  return !plan.daysOfWeek?.length || plan.daysOfWeek.includes(weekday(day));
}

/** Autonomous verification: read the metric and compare with the target. No user effort. */
export function evaluateAutonomous(
  plan: HabitPlan, integrations: Integrations, userId: string, day: string,
): { status: DayStatus; detail: string } {
  const a = plan.autonomous;
  if (!a) return { status: "unknown", detail: "no autonomous check configured" };
  const value = integrations.metric(userId, a.source, a.metric, day);
  if (value === null) return { status: "unknown", detail: `no ${a.source} data for ${a.metric}` };
  const ok = a.comparator === "lte" ? value <= a.threshold : value >= a.threshold;
  const unit = a.unit ? ` ${a.unit}` : "";
  const target = `${a.comparator === "lte" ? "<=" : ">="} ${a.threshold}${unit}`;
  return { status: ok ? "done" : "missed", detail: `${a.metric}: ${value}${unit} (target ${target})` };
}
