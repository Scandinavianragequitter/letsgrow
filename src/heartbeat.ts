/**
 * The proactive side of the agent: a timer that texts chats on its own.
 *
 * Photon has no scheduler, so the clock lives here. Note the name collision:
 * the iMessage provider also has a `onHeartbeat` hook, but that is a liveness
 * signal from the live message subscription (see `IMessageHeartbeat`) and has
 * nothing to do with these outbound texts. Stream liveness is tracked
 * separately in agent.ts.
 *
 * Scheduling is per chat, not global: each chat's next heartbeat is one
 * interval after its own last heartbeat (or after its first inbound message,
 * for a chat that has never had one). A single global timer wakes every
 * `HEARTBEAT_TICK_SECONDS` and sends whatever is due, one chat at a time.
 */

import type { Space } from "spectrum-ts";
import { text } from "spectrum-ts";

import type { Config } from "./config.ts";
import type { KnownSpace, SpaceStore } from "./store.ts";

export type SendOutcome =
  | { ok: true; skipped?: undefined }
  | { ok: false; skipped: "paused" | "parked" | "unresolved"; error?: undefined }
  | { ok: false; skipped?: undefined; error: Error };

export interface HeartbeatDeps {
  config: Config;
  store: SpaceStore;
  /** Turns a stored chat back into a live `Space` we can send into. */
  resolveSpace: (known: KnownSpace) => Promise<Space | undefined>;
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
    if (!known) return { ok: false, skipped: "unresolved" };
    if (reason === "scheduled" && known.paused) return { ok: false, skipped: "paused" };
    if (reason === "scheduled" && known.parked) return { ok: false, skipped: "parked" };

    const space = await this.#deps.resolveSpace(known).catch((error: unknown) => {
      console.warn(`[heartbeat] could not resolve ${spaceId}: ${describe(error)}`);
      return undefined;
    });
    if (!space) {
      store.update(spaceId, {
        consecutiveFailures: known.consecutiveFailures + 1,
        lastErrorAt: this.#now.toISOString(),
        lastError: "space could not be resolved",
      });
      return { ok: false, skipped: "unresolved" };
    }

    const sentAt = this.#now;
    const body = renderHeartbeat(known, sentAt, this.intervalMinutes(known));
    try {
      await space.send(text(body));
      store.update(spaceId, {
        lastHeartbeatAt: sentAt.toISOString(),
        heartbeatCount: known.heartbeatCount + 1,
        consecutiveFailures: 0,
        parked: false,
      });
      console.log(
        `[heartbeat] ${reason} -> ${spaceId} (#${known.heartbeatCount + 1})`,
      );
      return { ok: true };
    } catch (error) {
      const failures = known.consecutiveFailures + 1;
      const parked = failures >= config.maxConsecutiveFailures;
      store.update(spaceId, {
        consecutiveFailures: failures,
        lastErrorAt: sentAt.toISOString(),
        lastError: describe(error),
        parked,
      });
      // Logged in full, on purpose: a send that starts failing on a chat that
      // used to work is the signal that the shared-line permission lapsed, and
      // the exact error text is the evidence for that.
      console.error(
        `[heartbeat] send to ${spaceId} failed (${failures}/${config.maxConsecutiveFailures}${
          parked ? ", parked until they text us again" : ""
        }): ${describe(error)}`,
      );
      if (error instanceof Error && error.stack) console.error(error.stack);
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
