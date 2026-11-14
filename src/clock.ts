// Virtual clock so a 60-day habit can be demoed in minutes.
// now() = start + (realElapsed * scale) + offset. Scale 1 = real time.

export class Clock {
  private readonly startReal = Date.now();
  private readonly startVirtual: number;
  private offsetMs = 0;
  constructor(private readonly scale = 1, startVirtual = Date.now()) {
    this.startVirtual = startVirtual;
  }
  now(): number {
    return this.startVirtual + (Date.now() - this.startReal) * this.scale + this.offsetMs;
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** YYYY-MM-DD of an instant in a time zone. */
export function dayKey(ms: number, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const t = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(b) - t(a)) / DAY);
}

/** 0 = Sunday ... 6 = Saturday for a YYYY-MM-DD key. */
export function weekday(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function tzOffsetMs(ms: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Instant for "HH:MM" on a YYYY-MM-DD day in a time zone. */
export function zonedTime(day: string, hhmm: string, tz: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}
