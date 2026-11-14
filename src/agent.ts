/**
 * page — a Photon Spectrum iMessage agent.
 *
 * Two halves:
 *   1. the inbound loop, which answers texts;
 *   2. the heartbeat, which texts on its own schedule (see heartbeat.ts).
 *
 * What the agent is *for* is still undecided, so the inbound half currently
 * answers only questions about itself and the commands that steer the
 * heartbeat. That is a deliberate stub, not the finished behaviour.
 *
 * Shared-line reminder: this project is in shared iMessage mode, so an
 * outbound message only lands if the recipient has an active assignment and
 * has messaged the line since. Every chat we text therefore got into the
 * registry by texting us first — see store.ts.
 */

import { Spectrum, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { Space } from "spectrum-ts";

import { loadConfig } from "./config.ts";
import { describe, formatMinutes, Heartbeat } from "./heartbeat.ts";
import { SpaceStore, type KnownSpace } from "./store.ts";

/**
 * A missing or malformed `.env` is a setup mistake, not a bug — report it as
 * one line and exit, rather than dumping a stack trace over the real message.
 */
function configOrExit() {
  try {
    return loadConfig();
  } catch (error) {
    console.error(`[agent] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const config = configOrExit();

const store = new SpaceStore(config.stateFile);
await store.load();

/** Last liveness beat per Photon line, from the provider's own stream hook. */
const streamSeenAt = new Map<string, number>();

const app = await Spectrum({
  projectId: config.projectId,
  projectSecret: config.projectSecret,
  providers: [
    imessage.config({
      // Provider-level liveness of the message subscription. Unrelated to our
      // outbound heartbeat; recorded so `status` can say whether the agent is
      // actually still connected rather than merely still running.
      onHeartbeat: (beat) => {
        streamSeenAt.set(beat.lineId, beat.receivedAt);
      },
    }),
  ],
});

const im = imessage(app);

/** Live `Space` handles, so a heartbeat need not re-resolve every time. */
const liveSpaces = new Map<string, Space>();

async function resolveSpace(known: KnownSpace): Promise<Space | undefined> {
  const cached = liveSpaces.get(known.id);
  if (cached) return cached;
  // After a restart there is no live handle, only the id we persisted.
  const space = known.phone
    ? await im.space.get(known.id, { phone: known.phone })
    : await im.space.get(known.id);
  liveSpaces.set(known.id, space);
  return space;
}

const heartbeat = new Heartbeat({ config, store, resolveSpace });

console.log(`[agent] project ${config.projectId}`);
console.log(`[agent] registry ${store.path} (${store.all().length} known chat(s))`);
heartbeat.start();

type Command =
  | { kind: "ping" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "interval"; minutes: number };

function parseCommand(raw: string): Command | undefined {
  const body = raw.trim().toLowerCase();
  if (body === "ping") return { kind: "ping" };
  if (body === "pause" || body === "stop" || body === "mute") return { kind: "pause" };
  if (body === "resume" || body === "start" || body === "unmute") return { kind: "resume" };
  if (body === "status") return { kind: "status" };
  if (body === "help" || body === "?" || body === "commands") return { kind: "help" };

  const every = /^every\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(body);
  if (every) {
    const amount = Number(every[1]);
    const unit = every[2] ?? "m";
    const minutes = unit.startsWith("h") ? amount * 60 : amount;
    if (Number.isFinite(minutes) && minutes >= 1) {
      return { kind: "interval", minutes: Math.round(minutes) };
    }
  }
  return undefined;
}

const HELP = [
  "page here. I don't have a job yet — Carl is still deciding what I should do.",
  "",
  "What works today:",
  "• ping — send a heartbeat right now",
  "• pause / resume — stop and restart my check-ins",
  "• every 15m / every 2h — change how often I text you",
  "• status — what I think my schedule is",
].join("\n");

function renderStatus(known: KnownSpace): string {
  const interval = heartbeat.intervalMinutes(known);
  const lines = [
    `every ${formatMinutes(interval)}${known.intervalMinutes ? " (set here)" : " (default)"}`,
    `sent: ${known.heartbeatCount}`,
  ];
  if (known.paused) {
    lines.push("paused — text `resume` to restart");
  } else if (known.parked) {
    lines.push("parked after repeated send failures; this message un-parks me");
  } else {
    const due = heartbeat.dueAt(known);
    const minutesLeft = Math.max(0, Math.round((due.getTime() - Date.now()) / 60_000));
    lines.push(`next: in ~${formatMinutes(minutesLeft)}`);
  }
  if (known.lastHeartbeatAt) {
    lines.push(`last: ${new Date(known.lastHeartbeatAt).toLocaleString("en-US")}`);
  }
  if (known.lastError) {
    lines.push(`last error: ${known.lastError}`);
  }
  const beat = known.phone ? streamSeenAt.get(known.phone) : undefined;
  if (beat) {
    lines.push(`stream: ok ${Math.round((Date.now() - beat) / 1000)}s ago`);
  }
  return lines.join("\n");
}

async function handleCommand(space: Space, known: KnownSpace, command: Command): Promise<void> {
  switch (command.kind) {
    case "ping": {
      const outcome = await heartbeat.send(known.id, "manual");
      if (!outcome.ok) {
        await space.send(text(`couldn't send a heartbeat: ${outcome.error ? describe(outcome.error) : outcome.skipped}`));
      }
      return;
    }
    case "pause": {
      store.update(known.id, { paused: true });
      await space.send(text("paused. text `resume` when you want check-ins back."));
      return;
    }
    case "resume": {
      const updated = store.update(known.id, { paused: false });
      const interval = formatMinutes(heartbeat.intervalMinutes(updated ?? known));
      await space.send(text(`back on — every ${interval}.`));
      return;
    }
    case "interval": {
      const updated = store.update(known.id, { intervalMinutes: command.minutes, paused: false });
      const due = updated ? heartbeat.dueAt(updated) : undefined;
      const when = due
        ? `next in ~${formatMinutes(Math.max(0, Math.round((due.getTime() - Date.now()) / 60_000)))}`
        : "";
      await space.send(text(`ok — every ${formatMinutes(command.minutes)}. ${when}`.trim()));
      return;
    }
    case "status": {
      const current = store.get(known.id) ?? known;
      await space.send(text(renderStatus(current)));
      return;
    }
    case "help": {
      await space.send(text(HELP));
      return;
    }
  }
}

/** Guards against the stream redelivering a message we already acted on. */
const handled = new Set<string>();

function remember(id: string): boolean {
  if (handled.has(id)) return false;
  handled.add(id);
  if (handled.size > 500) {
    // Bounded: drop the oldest insertion, which Set iteration yields first.
    const oldest = handled.values().next();
    if (!oldest.done) handled.delete(oldest.value);
  }
  return true;
}

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`\n[agent] ${signal} — shutting down`);
  heartbeat.stop();
  try {
    await app.stop();
  } catch (error) {
    console.warn(`[agent] stop() failed: ${describe(error)}`);
  }
  await store.flush();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log("[agent] listening");

for await (const [space, message] of app.messages) {
  // Our own sends come back through the stream on some platforms.
  if (message.direction !== "inbound") continue;
  if (!remember(message.id)) continue;

  liveSpaces.set(space.id, space);

  const platformSpace = imessage.is(space) ? space : undefined;
  const sender = message.sender as { address?: unknown } | undefined;
  const known = store.recordInbound({
    id: space.id,
    phone: platformSpace?.phone,
    type: platformSpace?.type,
    address: typeof sender?.address === "string" ? sender.address : undefined,
    at: message.timestamp ?? new Date(),
  });

  if (message.content.type !== "text") {
    console.log(`[agent] inbound ${message.content.type} from ${space.id} — noted, no reply`);
    continue;
  }

  const body = message.content.text;
  console.log(`[agent] inbound from ${space.id}: ${body.length} char(s)`);

  const command = parseCommand(body);
  try {
    if (command) {
      await handleCommand(space, known, command);
    } else {
      // TODO(carl): this is where the agent's real behaviour goes.
      await space.send(text(HELP));
    }
  } catch (error) {
    console.error(`[agent] reply to ${space.id} failed: ${describe(error)}`);
  }
}
