import ICAL from "ical.js";
import { allDayMs, type CalEvent } from "./mock.js";

// Read a published calendar (Apple "Public Calendar" link, or any .ics URL) and expand repeating
// events into concrete occurrences. Apple shares these as webcal://, which is plain HTTPS.

export function normalizeCalendarUrl(url: string): string {
  const u = url.trim().replace(/^webcals?:\/\//i, "https://");
  if (!/^https?:\/\//i.test(u)) throw new Error("That doesn't look like a calendar link (expected webcal:// or https://).");
  return u;
}

export async function fetchIcs(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(normalizeCalendarUrl(url), { headers: { Accept: "text/calendar, */*" }, redirect: "follow" });
  if (!res.ok) throw new Error(`The calendar link answered ${res.status}. Is the calendar still public?`);
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("The link didn't return a calendar.");
  return text;
}

/** Events (title, start, end) overlapping [fromMs, toMs), recurrences expanded. All-day events are kept and flagged. */
export function eventsInWindow(icsText: string, fromMs: number, toMs: number): CalEvent[] {
  const root = new ICAL.Component(ICAL.parse(icsText));
  for (const tz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);
  const out: CalEvent[] = [];
  const vevents = root.getAllSubcomponents("vevent");
  const overrides = new Map<string, ICAL.Event[]>();
  const masters: ICAL.Event[] = [];
  for (const v of vevents) {
    const e = new ICAL.Event(v);
    if (e.isRecurrenceException()) {
      const list = overrides.get(e.uid) ?? [];
      list.push(e); overrides.set(e.uid, list);
    } else masters.push(e);
  }
  for (const e of masters) {
    for (const ex of overrides.get(e.uid) ?? []) e.relateException(ex);
    const title = e.summary || "(untitled)";
    const push = (t: string, start: ICAL.Time, end: ICAL.Time | null) => {
      if (start.isDate) {
        const ms = allDayMs(start.year, start.month, start.day);
        if (ms >= fromMs && ms < toMs) out.push({ title: t, startMs: ms, endMs: ms, allDay: true });
        return ms;
      }
      const s = start.toJSDate().getTime(), en = (end ?? start).toJSDate().getTime();
      if (s < toMs && en > fromMs) out.push({ title: t, startMs: s, endMs: en });
      return s;
    };
    if (!e.isRecurring()) { push(title, e.startDate, e.endDate); continue; }
    const it = e.iterator();
    for (let next = it.next(), guard = 0; next && guard < 2000; next = it.next(), guard++) {
      const occ = e.getOccurrenceDetails(next);
      if (push(occ.item.summary || title, occ.startDate, occ.endDate) >= toMs) break;
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
