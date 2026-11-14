/**
 * Scheduler tests. These cover the parts that are easy to get subtly wrong and
 * expensive to observe in production — a heartbeat is an hour apart, so waiting
 * for one to verify the arithmetic is not a workable loop.
 *
 * The real Photon connection is not involved: `resolveSpace` hands back a fake
 * space and the clock is injected, so `npm test` needs no credentials.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Space } from "spectrum-ts";

import type { Config } from "./config.ts";
import { formatMinutes, Heartbeat } from "./heartbeat.ts";
import { SpaceStore } from "./store.ts";

const BASE_CONFIG: Config = {
  projectId: "pho_prj_test",
  projectSecret: "unused",
  heartbeatMinutes: 60,
  heartbeatEnabled: true,
  tickSeconds: 20,
  stateFile: "unused",
  maxConsecutiveFailures: 3,
};

interface Harness {
  store: SpaceStore;
  heartbeat: Heartbeat;
  sent: string[];
  now: Date;
  fail: boolean;
  advance(minutes: number): void;
}

async function harness(overrides: Partial<Config> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "page-heartbeat-"));
  const store = new SpaceStore(join(dir, "state.json"));
  await store.load();

  const state = {
    now: new Date("2026-11-14T12:00:00.000Z"),
    sent: [] as string[],
    fail: false,
  };

  const space = {
    id: "space-1",
    send: async (content: unknown) => {
      if (state.fail) throw new Error("Target not allowed for this project");
      state.sent.push(JSON.stringify(content));
      return undefined;
    },
  } as unknown as Space;

  const heartbeat = new Heartbeat({
    config: { ...BASE_CONFIG, ...overrides },
    store,
    resolveSpace: async () => space,
    now: () => state.now,
  });

  return {
    store,
    heartbeat,
    get sent() {
      return state.sent;
    },
    get now() {
      return state.now;
    },
    get fail() {
      return state.fail;
    },
    set fail(value: boolean) {
      state.fail = value;
    },
    advance(minutes: number) {
      state.now = new Date(state.now.getTime() + minutes * 60_000);
    },
  } as Harness;
}

function register(h: Harness) {
  return h.store.recordInbound({ id: "space-1", phone: "+16289988199", type: "dm", at: h.now });
}

test("a chat that just texted is not heartbeated immediately", async () => {
  const h = await harness();
  const known = register(h);
  assert.equal(h.heartbeat.isDue(known), false, "a fresh chat should wait a full interval");
  await h.heartbeat.tick();
  assert.equal(h.sent.length, 0);
});

test("the first heartbeat lands one interval after the inbound message", async () => {
  const h = await harness();
  register(h);
  h.advance(59);
  await h.heartbeat.tick();
  assert.equal(h.sent.length, 0, "not due at 59 minutes");
  h.advance(1);
  await h.heartbeat.tick();
  assert.equal(h.sent.length, 1, "due at 60 minutes");
  assert.equal(h.store.get("space-1")?.heartbeatCount, 1);
});

test("the schedule moves forward by a full interval after each send", async () => {
  const h = await harness();
  register(h);
  h.advance(60);
  await h.heartbeat.tick();
  h.advance(30);
  await h.heartbeat.tick();
  assert.equal(h.sent.length, 1, "half an interval later is not due again");
  h.advance(30);
  await h.heartbeat.tick();
  assert.equal(h.sent.length, 2);
});

test("pause stops the schedule and resume restarts it", async () => {
  const h = await harness();
  register(h);
  h.store.update("space-1", { paused: true });
  h.advance(600);
  await h.heartbeat.tick();
  assert.equal(h.sent.length, 0, "a paused chat is never due");

  h.store.update("space-1", { paused: false });
  await h.heartbeat.tick();
  assert.equal(h.sent.length, 1, "resume makes the overdue heartbeat fire");
});

test("a per-chat interval overrides the process default", async () => {
  const h = await harness();
  register(h);
  h.store.update("space-1", { intervalMinutes: 15 });
  h.advance(15);
  await h.heartbeat.tick();
  assert.equal(h.sent.length, 1);
});

test("ping sends regardless of the schedule and still advances it", async () => {
  const h = await harness();
  register(h);
  const outcome = await h.heartbeat.send("space-1", "manual");
  assert.equal(outcome.ok, true);
  assert.equal(h.sent.length, 1);
  h.advance(59);
  await h.heartbeat.tick();
  assert.equal(h.sent.length, 1, "a manual send counts against the next scheduled one");
});

test("repeated send failures park the chat instead of retrying forever", async () => {
  const h = await harness();
  register(h);
  h.fail = true;
  for (let i = 0; i < 4; i += 1) {
    h.advance(60);
    await h.heartbeat.tick();
  }
  const parked = h.store.get("space-1");
  assert.equal(parked?.parked, true, "should park at maxConsecutiveFailures");
  assert.equal(parked?.consecutiveFailures, 3, "and stop counting once parked");
  assert.match(parked?.lastError ?? "", /Target not allowed/);
});

test("a new inbound message un-parks a chat and clears its failures", async () => {
  const h = await harness();
  register(h);
  h.fail = true;
  for (let i = 0; i < 4; i += 1) {
    h.advance(60);
    await h.heartbeat.tick();
  }
  assert.equal(h.store.get("space-1")?.parked, true);

  h.fail = false;
  const revived = h.store.recordInbound({ id: "space-1", at: h.now });
  assert.equal(revived.parked, false);
  assert.equal(revived.consecutiveFailures, 0);
  h.advance(60);
  await h.heartbeat.tick();
  assert.equal(h.sent.length, 1, "a revived chat is heartbeated again");
});

test("the registry survives a restart", async () => {
  const h = await harness();
  register(h);
  h.store.update("space-1", { intervalMinutes: 15, heartbeatCount: 7 });
  await h.store.flush();

  const reopened = new SpaceStore(h.store.path);
  await reopened.load();
  const restored = reopened.get("space-1");
  assert.equal(restored?.intervalMinutes, 15);
  assert.equal(restored?.heartbeatCount, 7);
  assert.equal(restored?.phone, "+16289988199");
});

test("intervals render readably", () => {
  assert.equal(formatMinutes(15), "15m");
  assert.equal(formatMinutes(60), "1h");
  assert.equal(formatMinutes(120), "2h");
  assert.equal(formatMinutes(90), "1.5h");
});
