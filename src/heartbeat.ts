/**
 * The proactive side of the agent: a timer that texts chats on its own.
 *
 * Photon has no scheduler, so the clock lives here.
 *
 * Scheduling is per chat, not global: each chat's next heartbeat is one
 * interval after its own last heartbeat (or after its first inbound message,
 * for a chat that has never had one). A single global timer wakes every
 * `HEARTBEAT_TICK_SECONDS` and sends whatever is due, one chat at a time.
 */

import type { Config } from "./config.ts";
import { isPermissionFailure, problemCode, type Outbox } from "./photon.ts";
import type { KnownSpace, SpaceStore } from "./store.ts";

export type SendOutcome =
  | { ok: true; skipped?: undefined }
  | { ok: false; skipped: "paused" | "parked" | "no-sender"; error?: undefined }
  | { ok: false; skipped?: undefined; error: Error };

export interface HeartbeatDeps {
  config: Config;
  store: SpaceStore;
  /** Where outbound texts go. An interface so tests need no network. */
  outbox: Outbox;
  /** Clock seam, so the scheduler is testable without waiting an hour. */
  now?: () => Date;
}

export class Heartbeat {
  #deps: HeartbeatDeps;
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;

  constructor(deps: HeartbeatDeps) {
    this.#deps = deps;
  }

  get #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  start(): void {
    if (this.#timer) return;
    const { config } = this.#deps;
    if (!config.heartbeatEnabled) {
      console.log("[heartbeat] disabled (HEARTBEAT_ENABLED=0) — replies only");
      return;
    }
    this.#timer = setInterval(() => {
      void this.tick();
    }, config.tickSeconds * 1000);
    // Do not hold the process open on the timer alone; the message loop owns
    // the lifetime, and an orphaned interval would keep a dead agent alive.
    this.#timer.unref();
    console.log(
      `[heartbeat] every ${config.heartbeatMinutes}m per chat, checked every ${config.tickSeconds}s`,
    );
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Effective interval for one chat, in minutes. */
  intervalMinutes(known: KnownSpace): number {
    return known.intervalMinutes ?? this.#deps.config.heartbeatMinutes;
  }

  /**
   * When this chat is next due. A chat that has never had a heartbeat is timed
   * from its first inbound message, so a fresh conversation does not get an
   * immediate unprompted text.
   */
  dueAt(known: KnownSpace): Date {
    const anchor = known.lastHeartbeatAt ?? known.lastInboundAt;
    return new Date(Date.parse(anchor) + this.intervalMinutes(known) * 60_000);
  }

  isDue(known: KnownSpace, now = this.#now): boolean {
    if (known.paused || known.parked) return false;
    return this.dueAt(known).getTime() <= now.getTime();
  }

  async tick(): Promise<void> {
    // A slow send must not let the next tick start a second pass over the
    // same chats; a double heartbeat is worse than a late one.
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#now;
      for (const known of this.#deps.store.all()) {
        if (!this.isDue(known, now)) continue;
        await this.send(known.id, "scheduled");
      }
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * Send one heartbeat. `manual` sends regardless of the schedule (the `ping`
   * command) and still counts, so the next scheduled one moves out by a full
   * interval.
   */
  async send(spaceId: string, reason: "scheduled" | "manual"): Promise<SendOutcome> {
    const { store, config } = this.#deps;
    const known = store.get(spaceId);
    if (!known) return { ok: false, skipped: "no-sender" };
    if (reason === "scheduled" && known.paused) return { ok: false, skipped: "paused" };
    if (reason === "scheduled" && known.parked) return { ok: false, skipped: "parked" };

    // Without the agent user id from an inbound message there is no legitimate
    // `senderId` to send as, and inventing one is explicitly wrong. Wait for
    // the chat to say something rather than guessing.
    if (!known.agentUserId) {
      console.warn(`[heartbeat] ${spaceId} has no agent sender id yet — skipping`);
      return { ok: false, skipped: "no-sender" };
    }

    const sentAt = this.#now;
    const sequence = known.heartbeatCount + 1;
    const body = renderHeartbeat(known, sentAt, this.intervalMinutes(known));
    try {
      await this.#deps.outbox.sendText({
        spaceId,
        senderId: known.agentUserId,
        text: body,
        // Stable per heartbeat, so a retry after a lost response cannot text
        // twice — Photon rejects a reused key.
        idempotencyKey: `heartbeat:${spaceId}:${sequence}`,
      });
      store.update(spaceId, {
        lastHeartbeatAt: sentAt.toISOString(),
        heartbeatCount: sequence,
        consecutiveFailures: 0,
        parked: false,
      });
      console.log(`[heartbeat] ${reason} -> ${spaceId} (#${sequence})`);
      return { ok: true };
    } catch (error) {
      const code = problemCode(error);
      // A permission failure is definitive, not flaky: the chat cannot be
      // texted until the person messages the line again. Park it at once
      // instead of spending two more attempts proving the same thing.
      const definitive = isPermissionFailure(error);
      const failures = known.consecutiveFailures + 1;
      const parked = definitive || failures >= config.maxConsecutiveFailures;
      store.update(spaceId, {
        consecutiveFailures: failures,
        lastErrorAt: sentAt.toISOString(),
        lastError: code ? `${code}: ${describe(error)}` : describe(error),
        parked,
      });
      console.error(
        `[heartbeat] send to ${spaceId} failed${code ? ` [${code}]` : ""} ` +
          `(${failures}/${config.maxConsecutiveFailures}` +
          `${parked ? (definitive ? ", parked — needs a fresh inbound message" : ", parked") : ""}): ` +
          describe(error),
      );
      return { ok: false, error: error instanceof Error ? error : new Error(describe(error)) };
    }
  }
}

/**
 * The heartbeat text itself.
 *
 * TODO(carl): placeholder wording. What the agent is *for* is still open, so
 * this deliberately says something verifiable rather than something invented —
 * a sequence number and the interval, so delivery and timing can be checked
 * from the phone. Replace once the agent has a job.
 */
export function renderHeartbeat(
  known: KnownSpace,
  at: Date,
  intervalMinutes: number,
): string {
  const template = process.env.HEARTBEAT_MESSAGE?.trim();
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const n = String(known.heartbeatCount + 1);
  const next = formatMinutes(intervalMinutes);
  if (template) {
    return template
      .replaceAll("{n}", n)
      .replaceAll("{time}", time)
      .replaceAll("{next}", next);
  }
  return `heartbeat #${n} · ${time} · next in ${next}`;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

export function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
