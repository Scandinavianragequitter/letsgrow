import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, dayKey, daysBetween, weekday, zonedTime } from "../src/clock.js";
import { normalizePhone } from "../src/phone.js";

test("zonedTime handles EST and EDT", () => {
  // 2026-11-14 is EST (UTC-5)
  assert.equal(new Date(zonedTime("2026-11-14", "18:00", "America/New_York")).toISOString(), "2026-11-14T23:00:00.000Z");
  // 2026-07-01 is EDT (UTC-4)
  assert.equal(new Date(zonedTime("2026-07-01", "18:00", "America/New_York")).toISOString(), "2026-07-01T22:00:00.000Z");
});

test("zonedTime across the DST change day", () => {
  // DST starts 2026-03-08: 18:00 that evening is already EDT
  assert.equal(new Date(zonedTime("2026-03-08", "18:00", "America/New_York")).toISOString(), "2026-03-08T22:00:00.000Z");
});

test("dayKey uses the user's zone, not UTC", () => {
  const ms = Date.UTC(2026, 10, 15, 2, 30); // 02:30Z = 21:30 on the 14th in New York
  assert.equal(dayKey(ms, "America/New_York"), "2026-11-14");
  assert.equal(dayKey(ms, "UTC"), "2026-11-15");
});

test("date helpers", () => {
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(daysBetween("2026-11-14", "2027-01-13"), 60);
  assert.equal(weekday("2026-11-16"), 1); // Monday
});

test("phone normalisation", () => {
  assert.equal(normalizePhone("(540) 449-2120"), "+15404492120");
  assert.equal(normalizePhone("+1 540 449 2120"), "+15404492120");
  assert.equal(normalizePhone("15404492120"), "+15404492120");
  assert.equal(normalizePhone("+49 151 2345 6789"), "+4915123456789");
  assert.equal(normalizePhone("12345"), null);
});
