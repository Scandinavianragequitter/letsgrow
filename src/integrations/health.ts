// Apple Health has no server API. Data reaches us by being POSTed from the person's iPhone:
// either by a Shortcut (simple JSON below) or by the "Health Auto Export" app's REST export.
// Both are turned into daily signals: steps, workout_minutes, workout_minutes:<Type>, sleep_hours, mindful_minutes.

export interface HealthDay { day: string; values: Record<string, number> }

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const typeKey = (t: string) => t.replace(/^(indoor|outdoor|traditional|functional)\s+/i, "").replace(/\s+/g, " ").trim().replace(/^\w/, (c) => c.toUpperCase());

/**
 * Simple format (what our Shortcut sends):
 * { "date": "2026-11-14", "steps": 8123, "workout_minutes": 35, "workouts": [{ "type": "Rowing", "minutes": 30 }],
 *   "sleep_hours": 7.2, "mindful_minutes": 10 }   // every field optional; date defaults to today
 */
function parseSimple(b: any, today: string): HealthDay[] {
  const day = typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(b.date) ? b.date.slice(0, 10) : today;
  const values: Record<string, number> = {};
  for (const k of ["steps", "workout_minutes", "sleep_hours", "mindful_minutes"]) {
    const v = num(b[k]); if (Number.isFinite(v)) values[k] = v;
  }
  let total = 0;
  for (const w of Array.isArray(b.workouts) ? b.workouts : []) {
    const m = num(w?.minutes); if (!Number.isFinite(m) || !w?.type) continue;
    const key = `workout_minutes:${typeKey(String(w.type))}`;
    values[key] = (values[key] ?? 0) + m; total += m;
  }
  if (values.workout_minutes === undefined && total > 0) values.workout_minutes = total;
  return Object.keys(values).length ? [{ day, values }] : [];
}

/** Health Auto Export REST format: { data: { metrics: [{ name, data: [{ date, qty }] }], workouts: [{ name, start, duration }] } } */
function parseAutoExport(b: any): HealthDay[] {
  const days = new Map<string, Record<string, number>>();
  const add = (day: string, key: string, v: number) => {
    const d = days.get(day) ?? {}; d[key] = (d[key] ?? 0) + v; days.set(day, d);
  };
  const metricMap: Record<string, { key: string; scale?: number }> = {
    step_count: { key: "steps" },
    apple_exercise_time: { key: "workout_minutes" },
    mindful_minutes: { key: "mindful_minutes" },
  };
  for (const m of b.data?.metrics ?? []) {
    for (const row of m.data ?? []) {
      const day = String(row.date ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (m.name === "sleep_analysis") {
        const v = num(row.totalSleep ?? row.asleep ?? row.qty);
        if (Number.isFinite(v)) add(day, "sleep_hours", v);
      } else if (metricMap[m.name]) {
        const v = num(row.qty); if (Number.isFinite(v)) add(day, metricMap[m.name].key, v);
      }
    }
  }
  for (const w of b.data?.workouts ?? []) {
    const day = String(w.start ?? "").slice(0, 10);
    const secs = num(typeof w.duration === "object" ? w.duration?.qty : w.duration);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(secs) || !w.name) continue;
    add(day, `workout_minutes:${typeKey(String(w.name))}`, Math.round(secs / 60));
  }
  return [...days].map(([day, values]) => ({ day, values }));
}

export function parseHealthPayload(body: unknown, today: string): HealthDay[] {
  if (!body || typeof body !== "object") throw new Error("Expected a JSON object.");
  const b = body as any;
  const out = b.data && (b.data.metrics || b.data.workouts) ? parseAutoExport(b) : parseSimple(b, today);
  if (!out.length) throw new Error("No health values found in the request.");
  for (const d of out) for (const k of Object.keys(d.values)) d.values[k] = Math.round(d.values[k] * 100) / 100;
  return out;
}
