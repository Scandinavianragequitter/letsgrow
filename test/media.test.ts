import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.js";
import { PhotonBetaMessenger, type PhotonMessagingClient } from "../src/messaging/photon-beta.js";
import type { InboundEvent } from "../src/messaging/messenger.js";
import { cardSvg, renderCard } from "../src/engine/card.js";
import { friendCardText } from "../src/engine/scheduler.js";
import { USER_PHONE, TZ, setup, startHabit, stretchPlan, zonedTime } from "./helpers.js";
import { ScriptedLlm, call } from "./fake-llm.js";

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const AGENT = { handle: "+16289988199", id: "pho_usr_agent", kind: "agent" };
const CARL = { handle: "+15404492120", id: "pho_usr_carl", kind: "human" };

function photon(inbox: any[]) {
  const log: string[] = [];
  const client: PhotonMessagingClient = {
    async listMessages() { return { items: inbox }; },
    async sendMessage(i) { log.push(`send ${JSON.stringify(i.body.content)}`); return {}; },
    async createOrGetUser() { throw new Error("unused"); },
    async createOrGetSpace() { throw new Error("unused"); },
    async setSpaceTyping(i) { log.push(`typing ${i.body.typing}`); return {}; },
    async getAttachment() { return { contentType: "image/png", sizeBytes: PNG_1PX.length }; },
    async downloadAttachment() { return new Blob([new Uint8Array(PNG_1PX)], { type: "image/png" }); },
    async uploadAttachment(i) { log.push(`upload ${i.headers["content-type"]} ${i.headers["content-length"]}`); return { id: "att_up" }; },
  };
  return { client, log };
}

test("a photo (with caption) arrives as an image event, downloaded and ready for the model", async () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const msg = { id: "m1", createdAt: new Date(now + 1000).toISOString(), sentBy: CARL, receivedBy: AGENT,
    space: { id: "spc", kind: "direct" },
    content: { type: "group", parts: [{ type: "attachment", attachmentId: "att1" }, { type: "text", text: "after training" }] } };
  const { client } = photon([msg]);
  const got: InboundEvent[] = [];
  const m = new PhotonBetaMessenger({ client, projectId: "pho_prj_x", store, now: () => now, pollMs: 60_000 });
  await m.start(async (e) => { got.push(e); });
  await m.stop();
  assert.equal(got[0].kind, "image");
  assert.equal(got[0].text, "after training");
  assert.deepEqual(got[0].images, [{ mediaType: "image/png", data: PNG_1PX.toString("base64") }]);
});

test("typing bubble goes on while the agent thinks and off after; images upload and send as attachments", async () => {
  const store = new Store(":memory:");
  const { client, log } = photon([]);
  const m = new PhotonBetaMessenger({ client, projectId: "pho_prj_x", store, now: () => 0 });
  store.setContact(CARL.handle, "spc", AGENT.id, 0);
  await m.typing(CARL.handle, true);
  await m.typing(CARL.handle, false);
  await m.sendImage(CARL.handle, PNG_1PX);
  assert.deepEqual(log, ["typing true", "typing false", `upload image/png ${PNG_1PX.length}`, `send {"type":"attachment","attachmentId":"att_up"}`]);
});

test("the coach sees the photo and can count it as proof", async () => {
  let seenImages = 0;
  const llm = new ScriptedLlm((c) => {
    const first = c.messages[0];
    if (first.role === "user") seenImages = first.images?.length ?? 0;
    return c.messages.some((x) => x.role === "tool") ? { text: "Stretch mat, legs up, counted.", toolCalls: [] } : call("log_completion");
  });
  const s = setup(true, llm);
  const start = zonedTime("2026-11-16", "09:00", TZ);
  s.setNow(start);
  const habit = startHabit(s, stretchPlan, start);
  await s.scheduler.tick(zonedTime("2026-11-16", "17:51", TZ));
  s.setNow(zonedTime("2026-11-16", "17:55", TZ));
  await s.transport.simulateInbound({ handle: USER_PHONE, kind: "image", images: [{ mediaType: "image/png", data: PNG_1PX.toString("base64") }] });
  assert.equal(seenImages, 1);
  assert.equal(s.store.pendingReminders(habit.id).length, 0, "the photo confirmed the reminder");
  assert.equal(s.out(USER_PHONE).at(-1), "Stretch mat, legs up, counted.");
});

test("day-60 card: real PNG; the friend's version hides the habit unless they were needed", () => {
  const statuses = Array.from({ length: 60 }, (_, i) => (i % 9 === 0 ? "missed" : "done")) as any;
  const png = renderCard({ days: 60, title: "“Stretch around training”", done: 53, counted: 60, longestStreak: 8, statuses, footer: "With Anna" });
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47], "PNG signature");
  assert.ok(png.length > 10_000);
  const hidden = friendCardText("Carl", "Stretch around training", 0);
  const shown = friendCardText("Carl", "Stretch around training", 2);
  assert.ok(!cardSvg({ days: 60, done: 53, counted: 60, longestStreak: 8, statuses, ...hidden }).includes("Stretch"));
  assert.match(cardSvg({ days: 60, done: 53, counted: 60, longestStreak: 8, statuses, ...shown }), /Carl: “Stretch around/);
  assert.match(shown.footer, /stepped in 2 times/);
});
