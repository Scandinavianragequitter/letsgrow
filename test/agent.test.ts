import { test } from "node:test";
import assert from "node:assert/strict";
import { FRIEND_PHONE, USER_PHONE, TZ, setup, startHabit, stretchPlan, zonedTime } from "./helpers.js";
import { ScriptedLlm, call, lastToolResult, type LlmCall } from "./fake-llm.js";
import { GeminiLlm } from "../src/agent/llm.js";
import type { LlmResult } from "../src/agent/llm.js";

const MON = "2026-11-16";

/** The model's side of a conversation: a function of what it is shown. */
function model(fn: (c: LlmCall, lastUser: string) => LlmResult) {
  return new ScriptedLlm((c) => {
    const u = c.messages.filter((m) => m.role === "user").at(-1);
    return fn(c, u && u.role === "user" ? u.content : "");
  });
}
const toolResults = (c: LlmCall) => c.messages.filter((m) => m.role === "tool").length;

test("planning: the agent looks at real data, gets a grounded plan saved, and answers on iMessage", async () => {
  const llm = model((c) => {
    switch (toolResults(c)) {
      case 0: return call("list_data_sources");
      case 1: return call("probe_data_source", { source: "calendar", keyword: "training" });
      case 2: return call("propose_plan", { plan: stretchPlan, habit_in_their_words: "stretch before each training" });
      default: return { text: "I'll text you 10 min before each training. Just ❤️ the message once you've stretched. Want to start?", toolCalls: [] };
    }
  });
  const s = setup(true, llm);
  s.setNow(zonedTime(MON, "09:00", TZ));
  await s.transport.simulateInbound({ handle: USER_PHONE, kind: "text", text: "I want to stretch before each training" });

  const probe = JSON.parse((llm.calls[2].messages.at(-1) as { content: string }).content);
  assert.ok(probe.count > 0 && probe.events[0].title === "Training", "the model saw the user's actual training events");
  const habit = s.store.currentHabit(s.user.id)!;
  assert.equal(habit.status, "planning");
  assert.equal(JSON.parse(habit.plan_json!).title, stretchPlan.title);
  assert.match(s.out(USER_PHONE).at(-1)!, /Want to start\?/);
  // one thread: their text and the reply, tagged as iMessage
  assert.deepEqual(s.store.chat(s.user.id).map((m) => [m.role, m.channel]), [["user", "imessage"], ["assistant", "imessage"]]);
});

test("planning: a plan that doesn't match the user's data comes back as an error the model can fix", async () => {
  const yoga = { ...stretchPlan, prompted: { ...stretchPlan.prompted!, reminders: [{ ...stretchPlan.prompted!.reminders[0], eventKeyword: "yoga" }] } };
  let sawError = "";
  const llm = model((c) => {
    if (toolResults(c) === 0) return call("propose_plan", { plan: yoga, habit_in_their_words: "stretch before yoga" });
    sawError = lastToolResult(c).error ?? "";
    return { text: "I don't see yoga in your calendar. What time do you usually go?", toolCalls: [] };
  });
  const s = setup(true, llm);
  s.setNow(zonedTime(MON, "09:00", TZ));
  await s.agent.chat(s.user, "stretch before yoga");
  assert.match(sawError, /No calendar events containing "yoga"/);
  assert.equal(s.store.currentHabit(s.user.id), undefined, "nothing saved");
});

test("starting: the model decides the user agreed, start_habit runs, and the invite comes back", async () => {
  const llm = model((c, last) => {
    if (last === "lets go" && toolResults(c) === 0) return call("start_habit");
    const r = lastToolResult(c);
    return { text: `Started! Forward this to a friend: ${r?.inviteMessageToForward}`, toolCalls: [] };
  });
  const s = setup(true, llm);
  s.setNow(zonedTime(MON, "09:00", TZ));
  s.actions.savePlan(s.user, stretchPlan, "stretch");
  await s.transport.simulateInbound({ handle: USER_PHONE, kind: "text", text: "lets go" });
  assert.equal(s.store.currentHabit(s.user.id)!.status, "active");
  assert.match(s.out(USER_PHONE).at(-1)!, /Remind me if I'm late on my new healthy habit\. Let's grow! http:\/\/localhost:3000\/join\//);
});

test("logging: a German tapback reaches the model verbatim with the waiting reminder in context", async () => {
  let system = "";
  const llm = model((c, last) => {
    system = c.system;
    if (last.includes("ein Herz hinzugefügt") && toolResults(c) === 0) return call("log_completion");
    return { text: "", toolCalls: [] }; // nothing to say back to a heart
  });
  const s = setup(true, llm);
  const start = zonedTime(MON, "09:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, stretchPlan, start);
  await s.scheduler.tick(zonedTime(MON, "17:51", TZ)); // the 17:50 reminder goes out
  s.setNow(zonedTime(MON, "17:55", TZ));
  const reminder = s.store.pendingReminders(habit.id)[0];
  await s.transport.simulateInbound({ handle: USER_PHONE, kind: "text", text: `„${reminder.text}“ ein Herz hinzugefügt` });
  assert.match(system, /remindersWaitingForConfirmation/);
  assert.match(system, new RegExp(`"id": ${reminder.id}`));
  assert.equal(s.store.pendingReminders(habit.id).length, 0, "confirmed");
  assert.equal(s.out(USER_PHONE).length, 1, "an empty reply sends nothing (only the reminder was sent)");
});

test("friends: first text activates them; support isn't passed on, they're pointed to text the person directly", async () => {
  let friendSystem = "";
  const llm = model((c) => {
    if (/just joined/.test(c.system)) return { text: "Hi Anna! I'll only text you if Carl slips.", toolCalls: [] };
    friendSystem = c.system;
    return { text: "Thank you! Send that straight to Carl, it means more from you.", toolCalls: [] };
  });
  const s = setup(true, llm);
  const start = zonedTime(MON, "09:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, stretchPlan, start);
  s.store.addFriend(habit.id, "Anna", FRIEND_PHONE, "+16289988199", start);
  await s.transport.simulateInbound({ handle: FRIEND_PHONE, kind: "text", text: "ping" });
  assert.equal(s.store.friends(habit.id)[0].state, "active");
  assert.match(s.out(FRIEND_PHONE)[0], /Hi Anna/);
  await s.transport.simulateInbound({ handle: FRIEND_PHONE, kind: "text", text: "Go Carl!" });
  assert.deepEqual(s.out(USER_PHONE), [], "nothing reaches Carl through the agent");
  assert.match(friendSystem, new RegExp(`sms:\\${USER_PHONE}`), "the friend's agent knows how to point them to Carl");
});

test("write() falls back to the given text when the model is unavailable", async () => {
  const s = setup(true, new ScriptedLlm(() => { throw new Error("429 rate limited"); }));
  assert.equal(await s.agent.write({ to: "Anna", purpose: "x", facts: {}, fallback: "fallback text" }), "fallback text");
});

test("Gemini client speaks the OpenAI-style tool-calling format", async () => {
  let sent: any;
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "start_habit", arguments: "{}" } },
    ] } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const llm = new GeminiLlm("key", "gemini-x", fakeFetch);
  const out = await llm.complete({
    system: "sys",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "list_data_sources", input: {} }] },
      { role: "tool", toolCallId: "a", name: "list_data_sources", content: "[]" },
    ],
    tools: [{ name: "start_habit", description: "d", schema: { type: "object", properties: {} } }],
  });
  assert.deepEqual(out.toolCalls, [{ id: "c1", name: "start_habit", input: {} }]);
  assert.equal(sent.messages[0].role, "system");
  assert.equal(sent.messages[2].tool_calls[0].function.name, "list_data_sources");
  assert.deepEqual(sent.messages[3], { role: "tool", tool_call_id: "a", content: "[]" });
  assert.equal(sent.tools[0].function.name, "start_habit");
});

test("friends: the habit stays private until they've been asked to step in", async () => {
  const systems: string[] = [];
  const llm = model((c) => { systems.push(c.system); return { text: "Hi Anna!", toolCalls: [] }; });
  const s = setup(true, llm);
  const start = zonedTime(MON, "09:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, stretchPlan, start);
  const f = s.store.addFriend(habit.id, "Anna", FRIEND_PHONE, "+16289988199", start);
  await s.transport.simulateInbound({ handle: FRIEND_PHONE, kind: "text", text: "ping" });
  await s.transport.simulateInbound({ handle: FRIEND_PHONE, kind: "text", text: "what is Carl working on?" });
  assert.ok(systems.every((x) => !x.includes(stretchPlan.title)), "the friend's agent isn't told the habit");
  assert.match(systems[1], /You don't know which habit it is/);

  s.store.addFriendEvent(habit.id, f.id, "nudge", MON, null, start); // Carl slipped and Anna was asked
  await s.transport.simulateInbound({ handle: FRIEND_PHONE, kind: "text", text: "what did he miss?" });
  assert.ok(systems.at(-1)!.includes(stretchPlan.title), "after a nudge the agent knows it");
});
