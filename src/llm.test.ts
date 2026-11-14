/**
 * Model-client tests. `fetch` is injected, so these run offline and need no
 * OpenRouter key — the point is the fallback chain and the responses that look
 * successful but carry nothing usable.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { History, Llm, LlmError } from "./llm.ts";

const MODELS = ["primary:free", "backup:free"] as const;

function ok(text: string, model = "primary:free") {
  return new Response(JSON.stringify({ model, choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Builds a fetch that returns each queued response in turn. */
function fetchQueue(responses: (Response | Error)[]) {
  const calls: { model: string; models: string[] }[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ model: body.model, models: body.models });
    const next = responses.shift();
    if (!next) throw new Error("no response queued");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

function llm(fetchImpl: typeof globalThis.fetch) {
  return new Llm({ apiKey: "test", models: MODELS, systemPrompt: "be brief", fetchImpl });
}

test("a successful call returns the text and the answering model", async () => {
  const { impl, calls } = fetchQueue([ok("hello there", "primary:free")]);
  const answer = await llm(impl).reply([{ role: "user", content: "hi" }]);
  assert.equal(answer.text, "hello there");
  assert.equal(answer.model, "primary:free");
  assert.equal(calls.length, 1, "no fallback call when the first succeeds");
});

test("the system prompt leads, then the history", async () => {
  const seen: unknown[] = [];
  const impl = (async (_u: unknown, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)).messages);
    return ok("ok");
  }) as unknown as typeof globalThis.fetch;
  await llm(impl).reply([
    { role: "user", content: "first" },
    { role: "assistant", content: "second" },
  ]);
  assert.deepEqual(seen[0], [
    { role: "system", content: "be brief" },
    { role: "user", content: "first" },
    { role: "assistant", content: "second" },
  ]);
});

test("an HTTP error falls through to the next model", async () => {
  const { impl, calls } = fetchQueue([
    new Response("rate limited", { status: 429 }),
    ok("from the backup", "backup:free"),
  ]);
  const answer = await llm(impl).reply([{ role: "user", content: "hi" }]);
  assert.equal(answer.text, "from the backup");
  assert.equal(answer.model, "backup:free");
  assert.deepEqual(
    calls.map((c) => c.model),
    ["primary:free", "backup:free"],
  );
});

test("a thrown error — a timeout — also falls through", async () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  const { impl } = fetchQueue([timeout, ok("recovered", "backup:free")]);
  const answer = await llm(impl).reply([{ role: "user", content: "hi" }]);
  assert.equal(answer.text, "recovered");
});

test("a 200 carrying an error in the choice is not a usable reply", async () => {
  // OpenRouter answers 200 with the error nested in the choice, so status
  // alone would have us text the user an empty message.
  const { impl, calls } = fetchQueue([
    new Response(
      JSON.stringify({ choices: [{ error: { code: 503, message: "upstream down" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    ok("second try", "backup:free"),
  ]);
  const answer = await llm(impl).reply([{ role: "user", content: "hi" }]);
  assert.equal(answer.text, "second try");
  assert.equal(calls.length, 2);
});

test("an empty completion is not a usable reply either", async () => {
  const { impl } = fetchQueue([ok("   "), ok("real answer", "backup:free")]);
  const answer = await llm(impl).reply([{ role: "user", content: "hi" }]);
  assert.equal(answer.text, "real answer");
});

test("every model failing throws, naming each attempt", async () => {
  const { impl } = fetchQueue([
    new Response("nope", { status: 500 }),
    new Response("also nope", { status: 502 }),
  ]);
  await assert.rejects(
    () => llm(impl).reply([{ role: "user", content: "hi" }]),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.attempts.length, 2);
      assert.match(error.message, /primary:free/);
      assert.match(error.message, /backup:free/);
      return true;
    },
  );
});

test("each request offers OpenRouter the remaining models for its own fallback", async () => {
  const { impl, calls } = fetchQueue([
    new Response("nope", { status: 500 }),
    ok("ok", "backup:free"),
  ]);
  await llm(impl).reply([{ role: "user", content: "hi" }]);
  assert.deepEqual(calls[0]?.models, ["primary:free", "backup:free"]);
  assert.deepEqual(calls[1]?.models, ["backup:free"], "already-failed models are not re-offered");
});

test("a model id without :free is flagged as billable", () => {
  assert.deepEqual(Llm.paidLooking(["a:free", "b:free"]), []);
  assert.deepEqual(Llm.paidLooking(["a:free", "openai/gpt-5.2"]), ["openai/gpt-5.2"]);
});

test("history is per chat and bounded", () => {
  const history = new History(4);
  for (let i = 0; i < 6; i += 1) {
    history.append("space-a", { role: "user", content: `a${i}` });
  }
  history.append("space-b", { role: "user", content: "b0" });

  assert.equal(history.get("space-a").length, 4, "oldest turns drop out");
  assert.deepEqual(
    history.get("space-a").map((t) => t.content),
    ["a2", "a3", "a4", "a5"],
  );
  assert.deepEqual(history.get("space-b").map((t) => t.content), ["b0"], "chats do not mix");

  history.clear("space-a");
  assert.equal(history.get("space-a").length, 0);
  assert.equal(history.get("space-b").length, 1, "clearing one chat leaves the other");
});
