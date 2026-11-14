import { test } from "node:test";
import assert from "node:assert/strict";
import { decideNudge, policyFromPreset, policyFromSuggestion } from "../src/policy/escalation.js";

const H = 3_600_000, D = 24 * H;

test("immediate policy nudges on the first miss with no delay", () => {
  const d = decideNudge(policyFromPreset("immediate"), { consecutiveMisses: 1, nudgeTimes: [], now: 1000 });
  assert.equal(d.nudge, true);
  assert.equal(d.sendAt, 1000);
});

test("two_in_a_row waits for a second consecutive miss", () => {
  const p = policyFromPreset("two_in_a_row");
  assert.equal(decideNudge(p, { consecutiveMisses: 1, nudgeTimes: [], now: 0 }).nudge, false);
  const d = decideNudge(p, { consecutiveMisses: 2, nudgeTimes: [], now: 0 });
  assert.equal(d.nudge, true);
  assert.equal(d.sendAt, 60 * 60_000); // 60 minute delay
});

test("repeat cadence: standard repeats every 2 extra misses", () => {
  const p = policyFromPreset("standard"); // threshold 1, repeat every 2
  const at = (n: number) => decideNudge(p, { consecutiveMisses: n, nudgeTimes: [], now: 0 }).nudge;
  assert.deepEqual([1, 2, 3, 4, 5].map(at), [true, false, true, false, true]);
});

test("gentle never repeats within a streak", () => {
  const p = policyFromPreset("gentle");
  const at = (n: number) => decideNudge(p, { consecutiveMisses: n, nudgeTimes: [], now: 0 }).nudge;
  assert.deepEqual([2, 3, 4, 5, 6].map(at), [false, true, false, false, false]);
});

test("weekly cap and minimum gap are enforced", () => {
  const p = { ...policyFromPreset("immediate"), maxNudgesPerWeek: 2, minHoursBetweenNudges: 12 };
  const now = 10 * D;
  assert.equal(decideNudge(p, { consecutiveMisses: 1, nudgeTimes: [now - 3 * D, now - 2 * D], now }).reason, "weekly nudge cap reached");
  assert.equal(decideNudge(p, { consecutiveMisses: 1, nudgeTimes: [now - 2 * H], now }).reason, "too soon after the last nudge");
  assert.equal(decideNudge(p, { consecutiveMisses: 1, nudgeTimes: [now - 20 * H], now }).nudge, true);
});

test("planner suggestion maps to a policy", () => {
  assert.equal(policyFromSuggestion(1).missedDaysBeforeNudge, 1);
  assert.equal(policyFromSuggestion(2).missedDaysBeforeNudge, 2);
  assert.equal(policyFromSuggestion(4).missedDaysBeforeNudge, 4);
});
