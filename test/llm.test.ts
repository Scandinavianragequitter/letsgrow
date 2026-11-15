import { test } from "node:test";
import assert from "node:assert/strict";
import { FallbackLlm, GEMINI_BASE_URL, GeminiLlm, createLlm, type LlmClient } from "../src/agent/llm.js";

const env = { anthropicModel: "claude-x", geminiModel: "gemini-x", webSearchMaxUses: 3 };

test("Claude runs the agents; Gemini only without a Claude key", () => {
  assert.equal(createLlm({ ...env, geminiKey: "g", anthropicKey: "a" }).label, "anthropic:claude-x+web_search");
  assert.equal(createLlm({ ...env, geminiKey: "g" }).label, "gemini:gemini-x");
  assert.equal(createLlm({ ...env, anthropicKey: "a" }).label, "anthropic:claude-x+web_search");
  assert.equal(createLlm(env).label, "none");
});

test("if Gemini fails, Claude answers; web searches go straight to Claude", async () => {
  const calls: string[] = [];
  const gemini: LlmClient = { label: "gemini", complete: async () => { calls.push("gemini"); throw new Error("429"); } };
  const claude: LlmClient = { label: "claude", canSearchWeb: true, complete: async () => { calls.push("claude"); return { text: "from claude", toolCalls: [] }; } };
  const llm = new FallbackLlm(gemini, claude);
  assert.equal((await llm.complete({ system: "", messages: [] })).text, "from claude");
  assert.deepEqual(calls, ["gemini", "claude"]);
  calls.length = 0;
  await llm.complete({ system: "", messages: [], webSearch: true });
  assert.deepEqual(calls, ["claude"]);
  assert.equal(llm.canSearchWeb, true, "the researcher stays available");
});

test("Gemini gets its own tool calls back unchanged (thought signatures)", async () => {
  const sent: any[] = [];
  const geminiCall = { id: "c1", type: "function", function: { name: "report_matches", arguments: "{\"events\":[0]}" }, extra_content: { google: { thought_signature: "sig" } } };
  const fakeFetch = (async (url: string, init: any) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [geminiCall] } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const llm = new GeminiLlm("key", "gemini-x", fakeFetch);
  const first = await llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }] });
  assert.equal(sent[0].url, `${GEMINI_BASE_URL}/chat/completions`);
  assert.deepEqual(first.toolCalls, [{ id: "c1", name: "report_matches", input: { events: [0] } }]);
  await llm.complete({ system: "s", messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: first.toolCalls, raw: first.raw },
    { role: "tool", toolCallId: "c1", name: "report_matches", content: "{\"ok\":true}" },
  ] });
  assert.deepEqual(sent[1].body.messages[2].tool_calls, [geminiCall]);
});

test("once Claude has made a tool call in a turn, Claude finishes it (Gemini would reject the call)", async () => {
  const calls: string[] = [];
  const gemini: LlmClient = { label: "gemini:x", complete: async () => { calls.push("gemini"); return { text: "", toolCalls: [] }; } };
  const claude: LlmClient = { label: "claude", complete: async () => { calls.push("claude"); return { text: "ok", toolCalls: [] }; } };
  await new FallbackLlm(gemini, claude).complete({ system: "", messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [{ id: "t", name: "cancel_habit", input: {} }], raw: [{ type: "tool_use", id: "t", name: "cancel_habit", input: {} }] },
    { role: "tool", toolCallId: "t", name: "cancel_habit", content: "{}" },
  ] });
  assert.deepEqual(calls, ["claude"]);
});

test("Gemini retries once on a 503 before giving up", async () => {
  let n = 0;
  const fakeFetch = (async () => (++n === 1
    ? new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 })
    : new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 }))) as unknown as typeof fetch;
  const out = await new GeminiLlm("k", "gemini-x", fakeFetch, GEMINI_BASE_URL, 1).complete({ system: "", messages: [{ role: "user", content: "x" }] });
  assert.equal(out.text, "hi");
  assert.equal(n, 2);
});
