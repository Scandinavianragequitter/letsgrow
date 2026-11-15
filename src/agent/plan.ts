import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24h");

export const ReminderSchema = z.object({
  anchor: z.enum(["calendar_event", "fixed_time"]),
  /** Case-insensitive substring of a calendar event title, e.g. "training". */
  eventKeyword: z.string().min(1).max(60).optional(),
  /** Which edge of the matching calendar event the offset is measured from. */
  edge: z.enum(["start", "end"]).optional(),
  /** Minutes relative to the edge. Negative = before. */
  offsetMinutes: z.number().int().min(-720).max(720).optional(),
  /** Local time for fixed_time reminders. */
  time: hhmm.optional(),
  /** The text sent to the user. Short and friendly; mention the one-tap reply. */
  text: z.string().min(2).max(200),
});

export const HabitPlanSchema = z
  .object({
    title: z.string().min(2).max(80),
    /** 1 to 3 short sentences shown to the user. */
    summary: z.string().min(2).max(400),
    mode: z.enum(["autonomous", "prompted"]),
    /** 0 = Sunday .. 6 = Saturday. Omit for every day. */
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    autonomous: z
      .object({
        source: z.enum(["screen_time", "health", "calendar", "email"]),
        metric: z.string().min(1).max(60),
        comparator: z.enum(["lte", "gte"]),
        threshold: z.number(),
        unit: z.string().max(20).optional(),
        /** Local time of day when the day is checked, e.g. "22:00". */
        evaluateAt: hhmm,
      })
      .optional(),
    prompted: z
      .object({
        reminders: z.array(ReminderSchema).min(1).max(4),
        confirmWith: z.enum(["heart", "reply"]).default("heart"),
        confirmWithinMinutes: z.number().int().min(15).max(720).default(180),
      })
      .optional(),
    /** After how many consecutive missed days should the friend be told. */
    suggestedMissedDaysBeforeFriendNudge: z.number().int().min(1).max(5),
    escalationRationale: z.string().max(200).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.mode === "autonomous" && !p.autonomous) {
      ctx.addIssue({ code: "custom", message: "mode=autonomous requires the autonomous block" });
    }
    if (p.mode === "prompted" && !p.prompted) {
      ctx.addIssue({ code: "custom", message: "mode=prompted requires the prompted block" });
    }
    for (const r of p.prompted?.reminders ?? []) {
      if (r.anchor === "calendar_event" && (!r.eventKeyword || !r.edge || r.offsetMinutes === undefined)) {
        ctx.addIssue({ code: "custom", message: "calendar_event reminders need eventKeyword, edge and offsetMinutes" });
      }
      if (r.anchor === "fixed_time" && !r.time) {
        ctx.addIssue({ code: "custom", message: "fixed_time reminders need time" });
      }
    }
  });

export type HabitPlan = z.output<typeof HabitPlanSchema>;
export type Reminder = z.output<typeof ReminderSchema>;
