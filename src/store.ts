/**
 * The registry of chats the agent is allowed to text.
 *
 * On a shared iMessage line Photon will only deliver an outbound message to
 * someone who has an active assignment *and* has messaged the line since that
 * assignment was made. That means the set of chats we may proactively text is
 * exactly the set of chats that have messaged us — so the inbound loop is the
 * only thing that may add to this registry. Nothing here invents a recipient.
 *
 * The file is a plain JSON document (gitignored) so a restart does not lose the
 * heartbeat schedule. It holds chat ids and timestamps only: no message bodies,
 * no credentials.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface KnownSpace {
  /** Platform space id, as it arrived on the inbound message. */
  id: string;
  /**
   * The Photon line this chat sits on. Load-bearing, not diagnostic: the
   * AGENT_LINE filter matches against it.
   */
  phone?: string;
  /**
   * The agent user that receives in this chat, taken from an inbound message's
   * `receivedBy.id`. Photon requires it as `senderId` on every send, and the
   * docs forbid deriving it from the line's phone number — so a chat we have
   * never received from cannot be texted, and this is why.
   */
  agentUserId?: string;
  type?: "dm" | "group";
  /** Counterpart handle, kept for diagnostics only. */
  address?: string;
  firstSeenAt: string;
  lastInboundAt: string;
  lastHeartbeatAt?: string;
  heartbeatCount: number;
  /** Per-chat override of `HEARTBEAT_MINUTES`, set by the `every <n>m` command. */
  intervalMinutes?: number;
  /** Set by `pause`; cleared by `resume`. Paused chats are skipped, not dropped. */
  paused?: boolean;
  consecutiveFailures: number;
  lastErrorAt?: string;
  lastError?: string;
  /** Set once a chat has failed too often — parked until it messages us again. */
  parked?: boolean;
}

interface StateFile {
  version: 1;
  spaces: Record<string, KnownSpace>;
  /**
   * How far the inbound poll has read, as an ISO timestamp. Persisted so a
   * restart neither re-processes old messages nor skips ones that arrived
   * while the agent was down.
   */
  cursor?: string;
}

const EMPTY: StateFile = { version: 1, spaces: {} };

export class SpaceStore {
  #path: string;
  #state: StateFile = structuredClone(EMPTY);
  /** Serializes writes so two quick updates cannot interleave on the file. */
  #writing: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = resolve(path);
  }

  get path(): string {
    return this.#path;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.#path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "spaces" in parsed &&
        typeof (parsed as StateFile).spaces === "object"
      ) {
        this.#state = {
          version: 1,
          spaces: (parsed as StateFile).spaces ?? {},
          cursor: (parsed as StateFile).cursor,
        };
        return;
      }
      throw new Error("unrecognized shape");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT") {
        // A corrupt state file must not stop the agent from answering texts.
        // Start clean and say so loudly rather than crashing on boot.
        console.warn(
          `[store] could not read ${this.#path} (${(error as Error).message}); starting with an empty registry`,
        );
      }
      this.#state = structuredClone(EMPTY);
    }
  }

  all(): KnownSpace[] {
    return Object.values(this.#state.spaces);
  }

  get(id: string): KnownSpace | undefined {
    return this.#state.spaces[id];
  }

  /**
   * Record an inbound message from a chat. This is the only way a chat enters
   * the registry, and it also un-parks a chat: a fresh inbound message is
   * precisely what restores send permission on a shared line.
   */
  recordInbound(input: {
    id: string;
    phone?: string;
    type?: "dm" | "group";
    address?: string;
    agentUserId?: string;
    at: Date;
  }): KnownSpace {
    const now = input.at.toISOString();
    const existing = this.#state.spaces[input.id];
    const next: KnownSpace = existing
      ? {
          ...existing,
          phone: input.phone ?? existing.phone,
          type: input.type ?? existing.type,
          address: input.address ?? existing.address,
          agentUserId: input.agentUserId ?? existing.agentUserId,
          lastInboundAt: now,
          consecutiveFailures: 0,
          parked: false,
        }
      : {
          id: input.id,
          phone: input.phone,
          type: input.type,
          address: input.address,
          agentUserId: input.agentUserId,
          firstSeenAt: now,
          lastInboundAt: now,
          heartbeatCount: 0,
          consecutiveFailures: 0,
        };
    this.#state.spaces[input.id] = next;
    this.#save();
    return next;
  }

  update(id: string, patch: Partial<KnownSpace>): KnownSpace | undefined {
    const existing = this.#state.spaces[id];
    if (!existing) return undefined;
    const next = { ...existing, ...patch, id: existing.id };
    this.#state.spaces[id] = next;
    this.#save();
    return next;
  }

  cursor(): string | undefined {
    return this.#state.cursor;
  }

  /** Advance the inbound poll cursor. Never moves backwards. */
  setCursor(iso: string): void {
    const current = this.#state.cursor;
    if (current && Date.parse(current) >= Date.parse(iso)) return;
    this.#state.cursor = iso;
    this.#save();
  }

  /** Flush pending writes — called on shutdown. */
  async flush(): Promise<void> {
    await this.#writing;
  }

  #save(): void {
    const snapshot = JSON.stringify(this.#state, null, 2);
    this.#writing = this.#writing.then(async () => {
      const tmp = `${this.#path}.${process.pid}.tmp`;
      try {
        await writeFile(tmp, `${snapshot}\n`, "utf8");
        await rename(tmp, this.#path);
      } catch (error) {
        console.warn(
          `[store] could not write ${dirname(this.#path)}: ${(error as Error).message}`,
        );
      }
    });
  }
}
