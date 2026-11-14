import { randomUUID } from "node:crypto";
import { Photon } from "@photon-ai/api";
import type { Store } from "../db.js";
import type { InboundEvent, InboundHandler, Messenger } from "./messenger.js";

/**
 * Real iMessage through Photon Beta (2.0): https://photon.codes/docs/beta
 *
 * - Credentials: a project ID (pho_prj_...) and a project API key (Bearer). No project secret.
 * - Receiving: Beta webhooks can't reach localhost, so we poll `listMessages` every few seconds.
 * - Sending: `sendMessage` needs the conversation (space) and the agent user that should speak.
 *   A shared line can't text first, so we learn both from each person's inbound text and store them.
 * - Beta iMessage has no tapback events. iOS delivers a tapback as text, like `Loved “…”` or
 *   (German) `„…“ ein Herz hinzugefügt`; it is passed to the agent as-is, which understands it.
 */

/** The subset of the Photon client this messenger uses (so tests can pass a fake). */
export interface PhotonMessagingClient {
  listMessages(input: { path: { id: string }; query: Record<string, unknown> }): Promise<{ items: any[]; nextPageToken?: string }>;
  sendMessage(input: { path: { id: string }; headers: { "idempotency-key": string }; body: Record<string, unknown> }): Promise<unknown>;
  createOrGetUser(input: { path: { id: string }; body: { handle: string; platform: string } }): Promise<{ id: string }>;
  createOrGetSpace(input: { path: { id: string }; headers: { "idempotency-key": string }; body: { participantIds: string[]; platform: string } }): Promise<{ id: string }>;
}

export function photonClient(apiKey: string): PhotonMessagingClient {
  const photon = new Photon({ headers: { Authorization: `Bearer ${apiKey}` } });
  return photon.projects as unknown as PhotonMessagingClient;
}

export function toInboundEvent(m: any): InboundEvent | undefined {
  const handle: string | undefined = m?.sentBy?.handle;
  if (!handle || m?.sentBy?.kind === "agent") return undefined;
  const c = m.content ?? {};
  if (c.type === "text" && typeof c.text === "string") {
    // Tapbacks arrive as text (e.g. „…“ ein Herz hinzugefügt); the agent reads them like any message.
    return { handle, kind: "text", text: c.text };
  }
  if (c.type === "reaction" && typeof c.reaction === "string") return { handle, kind: "reaction", emoji: c.reaction };
  return { handle, kind: "other" };
}

export interface PhotonBetaOptions {
  client: PhotonMessagingClient;
  projectId: string;
  store: Store;
  now: () => number;
  pollMs?: number;
  /** On first start, ignore messages older than this (ms). Later starts resume from the saved cursor. */
  lookbackMs?: number;
}

export class PhotonBetaMessenger implements Messenger {
  readonly mode = "photon" as const;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private handler: InboundHandler | undefined;
  constructor(private o: PhotonBetaOptions) {}

  private get path() { return { id: this.o.projectId }; }
  /** Wall-clock time for the Photon API (the app clock can be fast-forwarded in demos). */
  private realNow() { return Date.now(); }

  async send(handle: string, body: string): Promise<void> {
    const { store, client } = this.o;
    let contact = store.getContact(handle);
    if (!contact) contact = await this.discoverContact(handle);
    if (!contact) {
      throw new Error(`Can't text ${handle} yet: on a shared line they have to text the line first.`);
    }
    await client.sendMessage({
      path: this.path,
      headers: { "idempotency-key": `letsgrow-${randomUUID()}` },
      body: { spaceId: contact.space_id, senderId: contact.agent_id, content: { type: "text", format: "plain", text: body } },
    });
    store.logMessage("out", handle, body, this.o.now());
  }

  /** Fallback when we never saw an inbound from this handle (e.g. they texted before the app ran). */
  private async discoverContact(handle: string) {
    const { store, client } = this.o;
    const agentId = store.anyAgentId();
    if (!agentId) return undefined;
    try {
      const human = await client.createOrGetUser({ path: this.path, body: { handle, platform: "imessage" } });
      const space = await client.createOrGetSpace({
        path: this.path,
        headers: { "idempotency-key": `letsgrow-space-${agentId}-${human.id}` },
        body: { participantIds: [agentId, human.id], platform: "imessage" },
      });
      store.setContact(handle, space.id, agentId, this.o.now());
      return store.getContact(handle);
    } catch {
      return undefined;
    }
  }

  async start(onInbound: InboundHandler): Promise<void> {
    this.handler = onInbound;
    if (!this.o.store.getKv("photon_cursor")) {
      this.o.store.setKv("photon_cursor", new Date(this.realNow() - (this.o.lookbackMs ?? 60_000)).toISOString());
    }
    await this.pollOnce();
    this.timer = setInterval(() => { void this.pollOnce(); }, this.o.pollMs ?? 3_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  /** Fetch new inbound iMessages since the cursor and dispatch them once each. Exposed for tests. */
  async pollOnce(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    let handled = 0;
    try {
      const { store, client } = this.o;
      const cursor = store.getKv("photon_cursor")!;
      let latest = cursor;
      let pageToken: string | undefined;
      do {
        const page = await client.listMessages({
          path: this.path,
          query: { direction: "received", order: "asc", pageSize: 100, platform: "imessage", createdSince: cursor, ...(pageToken ? { pageToken } : {}) },
        });
        for (const m of page.items) {
          if (m.createdAt && m.createdAt > latest) latest = m.createdAt;
          if (!m.id || !store.markSeen(m.id, this.o.now())) continue;
          const e = toInboundEvent(m);
          if (!e) continue;
          if (m.space?.id && m.receivedBy?.id) store.setContact(e.handle, m.space.id, m.receivedBy.id, this.o.now());
          store.logMessage("in", e.handle, e.kind === "reaction" ? `(reaction ${e.emoji})` : (e.text ?? "(attachment)"), this.o.now());
          try { await this.handler?.(e); handled++; }
          catch (err) { console.error("inbound handler failed:", err); }
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      // Results are eventually consistent: keep a small overlap; markSeen drops repeats.
      const overlap = new Date(Date.parse(latest) - 30_000).toISOString();
      if (overlap > cursor) store.setKv("photon_cursor", overlap);
    } catch (err) {
      console.error("Photon poll failed:", (err as Error).message);
    } finally {
      this.polling = false;
    }
    return handled;
  }
}
