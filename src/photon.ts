/**
 * The Photon transport.
 *
 * Everything that knows about Photon's wire format lives here. The scheduler
 * and the registry see only the plain shapes below, so replacing this file —
 * with Socket.IO live events, or with spectrum-ts if the project ever moves to
 * Stable — should not touch them.
 *
 * Why polling: `@photon-ai/api` ships no live-events client (its only
 * dependency is zod), so the documented alternative would mean adding
 * socket.io-client and wiring the event protocol by hand. Polling with a
 * persisted cursor plus id de-duplication is the honest trade: a few seconds of
 * latency on an inbound text, and nothing is silently dropped. `Inbox` is an
 * interface so that trade can be revisited without touching the agent.
 */

import { Photon } from "@photon-ai/api";
import { ApiError } from "@photon-ai/api";

/** An inbound text, flattened out of Photon's platform-tagged message union. */
export interface InboundMessage {
  id: string;
  spaceId: string;
  spaceKind: string | undefined;
  /**
   * The agent user that received this message. It is also the `senderId` we
   * must quote to send into this space — and the docs are explicit that it
   * must come from an inbound message rather than be derived from the line's
   * phone number, which is why the registry persists it.
   */
  agentUserId: string | undefined;
  /**
   * The receiving line's own handle, e.g. "+16289988199". A project can hold
   * several shared lines at once, and the same person texting from a different
   * handle lands on a different line as a different chat — so this is what the
   * AGENT_LINE filter matches on.
   */
  agentHandle: string | undefined;
  senderUserId: string | undefined;
  senderHandle: string | undefined;
  contentType: string | undefined;
  text: string | undefined;
  createdAt: string;
}

export interface Inbox {
  /** Everything received at or after `sinceISO`, oldest first. */
  poll(sinceISO: string): Promise<InboundMessage[]>;
}

export interface Outbox {
  /**
   * `idempotencyKey` must be stable for a given logical send: Photon rejects a
   * reused key, which is exactly what stops a retry from texting twice.
   */
  sendText(input: {
    spaceId: string;
    senderId: string;
    text: string;
    idempotencyKey: string;
    parentMessageId?: string;
  }): Promise<void>;
}

/** Reads a string property off a generated union member without fighting it. */
function str(source: unknown, key: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function obj(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  return (source as Record<string, unknown>)[key];
}

/**
 * Photon's message content is a tagged union per platform; a text message
 * carries `{ type: "text", text }`. Anything else returns undefined text, and
 * the agent treats it as "noted, no reply" rather than guessing.
 */
function normalize(raw: unknown): InboundMessage | undefined {
  const id = str(raw, "id");
  const space = obj(raw, "space");
  const spaceId = str(space, "id");
  if (!id || !spaceId) return undefined;

  const content = obj(raw, "content");
  const contentType = str(content, "type");
  const sentBy = obj(raw, "sentBy");
  const receivedBy = obj(raw, "receivedBy");

  return {
    id,
    spaceId,
    spaceKind: str(space, "kind"),
    agentUserId: str(receivedBy, "id"),
    agentHandle: str(receivedBy, "handle") ?? str(receivedBy, "address"),
    senderUserId: str(sentBy, "id"),
    senderHandle: str(sentBy, "handle") ?? str(sentBy, "address"),
    contentType,
    text: contentType === "text" ? str(content, "text") : undefined,
    createdAt:
      str(raw, "createdAt") ??
      str(obj(raw, "timestamps"), "receivedAt") ??
      new Date().toISOString(),
  };
}

export class PhotonTransport implements Inbox, Outbox {
  #photon: Photon;
  #projectId: string;

  constructor(options: {
    projectId: string;
    projectSecret: string;
    timeoutMs?: number;
  }) {
    this.#projectId = options.projectId;
    this.#photon = new Photon({
      headers: { Authorization: `Bearer ${options.projectSecret}` },
      timeoutMs: options.timeoutMs,
      // The SDK's default retry (408/429/502/503/504, three attempts) is left
      // on deliberately. Photon's idempotency contract is that the same key
      // resumes or replays the same run, so a retried send cannot text twice —
      // which is exactly why every send below carries a stable key. Dropping
      // the retry would trade that safety for nothing.
    });
  }

  async poll(sinceISO: string): Promise<InboundMessage[]> {
    const messages: InboundMessage[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.#photon.projects.listMessages({
        path: { id: this.#projectId },
        query: {
          createdSince: sinceISO,
          direction: "received",
          platform: "imessage",
          order: "asc",
          pageSize: 100,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      for (const item of page.items ?? []) {
        const normalized = normalize(item);
        if (normalized) messages.push(normalized);
      }
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
    return messages;
  }

  async sendText(input: {
    spaceId: string;
    senderId: string;
    text: string;
    idempotencyKey: string;
    parentMessageId?: string;
  }): Promise<void> {
    await this.#photon.projects.sendMessage({
      path: { id: this.#projectId },
      headers: { "idempotency-key": input.idempotencyKey },
      body: {
        spaceId: input.spaceId,
        senderId: input.senderId,
        content: { type: "text", format: "plain", text: input.text },
        ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
      },
    });
  }
}

/**
 * The problem code Photon returned, e.g. SHARED_LINE_INBOUND_REQUIRED. Photon
 * answers with RFC-9457 problem documents, so the code is the machine-readable
 * part worth branching on — the message is for humans.
 */
export function problemCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const code = str(error.body, "code");
  return code ?? String(error.status);
}

/**
 * Whether a send failure means "this chat will not accept messages until the
 * person texts us again". Retrying these is pointless; the registry parks the
 * chat and a fresh inbound message revives it.
 */
export function isPermissionFailure(error: unknown): boolean {
  const code = problemCode(error);
  return (
    code === "SHARED_LINE_INBOUND_REQUIRED" ||
    code === "SHARED_LINE_NOT_ASSIGNED" ||
    code === "SPACE_NOT_SENDABLE" ||
    code === "SENDER_NOT_SENDABLE"
  );
}
