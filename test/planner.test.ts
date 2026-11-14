import { test } from "node:test";
import assert from "node:assert/strict";
import { Planner } from "../src/agent/planner.js";
import type { LlmClient, LlmTurn } from "../src/agent/llm.js";
import { MockIntegrations } from "../src/integrations/mock.js";
import { Store } from "../src/db.js";

const integrations = new MockIntegrations(new Store(":memory:"), true);
const good = {
  title: "Less Instagram", summary: "I'll check Screen Time every evening.", mode: "autonomous",
  autonomous: { source: "screen_time", metric: "app_minutes:Instagram", comparator: "lte", threshold: 60, unit: "min", evaluateAt: "22:00" },
  suggestedMissedDaysBeforeFriendNudge: 1,
};

function fake(turns: LlmTurn[]): LlmClient & { calls: number } {
  return { calls: 0, async complete() { return turns[Math.min(this.calls++, turns.length - 1)]; } };
}

test("a valid propose_plan call returns the plan and the short reply", async () => {
  const llm = fake([{ text: "I'll check Screen Time each evening. Nothing for you to do.", toolCalls: [{ name: "propose_plan", input: good }] }]);
  const r = await new Planner(llm, integrations).turn("Carl", [], "less instagram, under an hour");
  assert.equal(r.plan?.mode, "autonomous");
  assert.match(r.reply, /Screen Time/);
});

test("an invalid plan is repaired once", async () => {
  const bad = { ...good, autonomous: undefined };
  const llm = fake([
    { text: "", toolCalls: [{ name: "propose_plan", input: bad }] },
    { text: "Fixed.", toolCalls: [{ name: "propose_plan", input: good }] },
  ]);
  const r = await new Planner(llm, integrations).turn("Carl", [], "x");
  assert.equal(llm.calls, 2);
  assert.ok(r.plan);
});

test("two invalid plans give a clarifying reply, no plan", async () => {
  const bad = { ...good, autonomous: undefined };
  const llm = fake([{ text: "", toolCalls: [{ name: "propose_plan", input: bad }] }]);
  const r = await new Planner(llm, integrations).turn("Carl", [], "x");
  assert.equal(r.plan, undefined);
  assert.match(r.reply, /concretely/);
});

test("a plain clarifying question passes through", async () => {
  const llm = fake([{ text: "How many minutes a day would be your goal?", toolCalls: [] }]);
  const r = await new Planner(llm, integrations).turn("Carl", [], "less instagram");
  assert.equal(r.plan, undefined);
  assert.match(r.reply, /How many minutes/);
});
