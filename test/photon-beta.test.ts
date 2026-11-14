import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.js";
import { PhotonBetaMessenger, toInboundEvent, type PhotonMessagingClient } from "../src/messaging/photon-beta.js";
import type { InboundEvent } from "../src/messaging/messenger.js";

const AGENT = { handle: "+16289988199", id: "pho_usr_agent", kind: "agent", platform: "imessage" };
const CARL = { handle: "+15404492120", id: "pho_usr_carl", kind: "human", platform: "imessage" };

// Shape copied from a real Beta listMessages response.
function received(id: string, text: string, createdAt: string) {
  return {
    id, createdAt, platform: "imessage", status: "received",
    content: { format: "plain", text, type: "text" },
    receivedBy: AGENT, sentBy: CARL,
    space: { id: "pho_spc_1", kind: "direct", participantIds: [AGENT.id, CARL.id], platform: "imessage" },
  };
}

function fakeClient(inbox: any[]) {
  const sent: any[] = [];
  const client: PhotonMessagingClient = {
    async listMessages({ query }) {
      return { items: inbox.filter((m) => m.createdAt >= (query.createdSince as string)) };
    },
    async sendMessage(input) { sent.push(input); return {}; },
    async createOrGetUser() { throw new Error("not used"); },
    async createOrGetSpace() { throw new Error("not used"); },
  };
  return { client, sent };
}

test("own messages are ignored; tapbacks pass through as text for the agent to read", () => {
  assert.equal(toInboundEvent({ ...received("m", "hi", "t"), sentBy: AGENT }), undefined);
  assert.deepEqual(toInboundEvent(received("m", "„Do it“ ein Herz hinzugefügt", "t")), { handle: CARL.handle, kind: "text", text: "„Do it“ ein Herz hinzugefügt" });
});

test("polls new inbound messages once, learns the conversation, and replies into it", async () => {
  const store = new Store(":memory:");
  const now = Date.now();
  const inbox = [received("pho_msg_old", "old", new Date(now - 3_600_000).toISOString())];
  const { client, sent } = fakeClient(inbox);
  const got: InboundEvent[] = [];
  const m = new PhotonBetaMessenger({ client, projectId: "pho_prj_x", store, now: () => now, pollMs: 60_000 });
  await m.start(async (e) => { got.push(e); });
  assert.equal(got.length, 0, "messages from before the first start are not replayed");

  inbox.push(received("pho_msg_1", "hi", new Date(now).toISOString()));
  inbox.push(received("pho_msg_2", "„Do it“ ein Herz hinzugefügt", new Date(now + 1).toISOString()));
  assert.equal(await m.pollOnce(), 2);
  assert.equal(await m.pollOnce(), 0, "no duplicates across polls");
  assert.deepEqual(got, [
    { handle: CARL.handle, kind: "text", text: "hi" },
    { handle: CARL.handle, kind: "text", text: "„Do it“ ein Herz hinzugefügt" },
  ]);

  await m.send(CARL.handle, "You're connected.");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.spaceId, "pho_spc_1");
  assert.equal(sent[0].body.senderId, AGENT.id);
  assert.deepEqual(sent[0].body.content, { type: "text", format: "plain", text: "You're connected." });
  await m.stop();
});

test("sending to someone who never texted the line fails clearly", async () => {
  const store = new Store(":memory:");
  const { client } = fakeClient([]);
  const m = new PhotonBetaMessenger({ client, projectId: "pho_prj_x", store, now: () => 0 });
  await assert.rejects(m.send("+15550009999", "hey"), /text the line first/);
});
