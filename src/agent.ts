/**
 * page — a Photon iMessage agent.
 *
 * Two halves:
 *   1. an inbound poll, which answers texts;
 *   2. the heartbeat, which texts on its own schedule (see heartbeat.ts).
 *
 * What the agent is *for* is still undecided, so the inbound half currently
 * answers only questions about itself and the commands that steer the
 * heartbeat. That is a deliberate stub, not the finished behaviour.
 *
 * Platform note: this talks to Photon's v2 Beta API through `@photon-ai/api`,
 * not to Spectrum Cloud through `spectrum-ts`. The two are different
 * generations with incompatible credentials — Spectrum Cloud validates a UUID
 * project id and rejects a `pho_prj_…` one outright. Beta is text and images
 * only, so mini-app cards would mean moving to Stable.
 *
 * Shared-line reminder: an outbound message only lands if the recipient's
 * assignment is active and they have messaged the line since. Every chat we
 * text therefore got into the registry by texting us first — see store.ts.
 */

import { readFile } from "node:fs/promises";

import { loadConfig } from "./config.ts";
import { describe, formatMinutes, Heartbeat } from "./heartbeat.ts";
import { History, Llm } from "./llm.ts";
import { type InboundMessage, PhotonTransport, problemCode } from "./photon.ts";
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

const transport = new PhotonTransport({
  projectId: config.projectId,
  projectSecret: config.projectSecret,
  timeoutMs: config.requestTimeoutMs,
});

const heartbeat = new Heartbeat({ config, store, outbox: transport });

/**
 * The conversation half. Absent a key the agent degrades to commands and
 * heartbeats rather than refusing to start — losing the chat is not a reason
 * to lose the scheduler.
 */
const llm = config.openrouterKey
  ? new Llm({
      apiKey: config.openrouterKey,
      models: config.models,
      systemPrompt: (await readFile(config.promptFile, "utf8").catch((error: unknown) => {
        console.warn(
          `[llm] could not read ${config.promptFile} (${describe(error)}); using a minimal prompt`,
        );
        return "You are \"page\", reached over iMessage. Keep replies to one or two sentences of plain text.";
      })).trim(),
      timeoutMs: config.llmTimeoutMs,
      maxTokens: config.llmMaxTokens,
    })
  : undefined;

const history = new History();

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
    lines.push("was parked after send failures; this message un-parks me");
  } else {
    const due = heartbeat.dueAt(known);
    const minutesLeft = Math.max(0, Math.round((due.getTime() - Date.now()) / 60_000));
    lines.push(`next: in ~${formatMinutes(minutesLeft)}`);
  }
  if (known.lastHeartbeatAt) {
    lines.push(`last: ${new Date(known.lastHeartbeatAt).toLocaleString("en-US")}`);
  }
  if (known.lastError) lines.push(`last error: ${known.lastError}`);
  return lines.join("\n");
}

/** Reply into a chat, quoting the inbound message so it threads. */
async function reply(message: InboundMessage, body: string): Promise<void> {
  if (!message.agentUserId) {
    console.warn(`[agent] cannot reply in ${message.spaceId}: no agent sender id`);
    return;
  }
  await transport.sendText({
    spaceId: message.spaceId,
    senderId: message.agentUserId,
    text: body,
    idempotencyKey: `reply:${message.id}`,
    parentMessageId: message.id,
  });
}

async function handleCommand(
  message: InboundMessage,
  known: KnownSpace,
  command: Command,
): Promise<void> {
  switch (command.kind) {
    case "ping": {
      const outcome = await heartbeat.send(known.id, "manual");
      if (!outcome.ok) {
        const why = outcome.error ? describe(outcome.error) : outcome.skipped;
        await reply(message, `couldn't send a heartbeat: ${why}`);
      }
      return;
    }
    case "pause": {
      store.update(known.id, { paused: true });
      await reply(message, "paused. text `resume` when you want check-ins back.");
      return;
    }
    case "resume": {
      const updated = store.update(known.id, { paused: false });
      await reply(message, `back on — every ${formatMinutes(heartbeat.intervalMinutes(updated ?? known))}.`);
      return;
    }
    case "interval": {
      const updated = store.update(known.id, { intervalMinutes: command.minutes, paused: false });
      const due = updated ? heartbeat.dueAt(updated) : undefined;
      const when = due
        ? `next in ~${formatMinutes(Math.max(0, Math.round((due.getTime() - Date.now()) / 60_000)))}`
        : "";
      await reply(message, `ok — every ${formatMinutes(command.minutes)}. ${when}`.trim());
      return;
    }
    case "status": {
      await reply(message, renderStatus(store.get(known.id) ?? known));
      return;
    }
    case "help": {
      await reply(message, HELP);
      return;
    }
  }
}

/**
 * Hold a typing indicator while the model thinks. Best-effort on purpose: a
 * failed indicator must never cost us the reply it was decorating.
 */
async function withTyping<T>(
  spaceId: string,
  senderId: string,
  work: () => Promise<T>,
): Promise<T> {
  const set = async (typing: boolean) => {
    try {
      await transport.setTyping({ spaceId, senderId, typing });
    } catch (error) {
      console.warn(`[agent] typing indicator failed: ${describe(error)}`);
    }
  };
  await set(true);
  try {
    return await work();
  } finally {
    await set(false);
  }
}

async function converse(
  message: InboundMessage,
  known: KnownSpace,
  model: Llm,
): Promise<void> {
  const senderId = message.agentUserId ?? known.agentUserId;
  if (!senderId) {
    console.warn(`[agent] cannot answer ${message.spaceId}: no agent sender id`);
    return;
  }
  const turns = history.append(message.spaceId, { role: "user", content: message.text ?? "" });
  try {
    const answer = await withTyping(message.spaceId, senderId, () => model.reply(turns));
    history.append(message.spaceId, { role: "assistant", content: answer.text });
    console.log(`[agent] ${answer.model} answered in ${answer.ms}ms`);
    await reply(message, answer.text);
  } catch (error) {
    // Drop the user turn again: a question the model never answered should not
    // sit in the transcript pretending it was part of the conversation.
    history.clear(message.spaceId);
    console.error(`[agent] model failed: ${describe(error)}`);
    await reply(message, "my brain is offline for a moment — try again in a bit?");
  }
}

/** Guards against the poll returning a message we already acted on. */
const handled = new Set<string>();

function remember(id: string): boolean {
  if (handled.has(id)) return false;
  handled.add(id);
  if (handled.size > 500) {
    const oldest = handled.values().next();
    if (!oldest.done) handled.delete(oldest.value);
  }
  return true;
}

async function handleInbound(message: InboundMessage): Promise<void> {
  if (!remember(message.id)) return;

  // With AGENT_LINE set, chats on the project's other lines are not ours to
  // answer. Dropped before the registry so they never become heartbeat
  // recipients either.
  if (config.agentLine && message.agentHandle !== config.agentLine) {
    console.log(
      `[agent] ignoring ${message.spaceId} on line ${message.agentHandle ?? "unknown"} ` +
        `(serving ${config.agentLine} only)`,
    );
    return;
  }

  const known = store.recordInbound({
    id: message.spaceId,
    phone: message.agentHandle,
    type: message.spaceKind === "direct" ? "dm" : "group",
    address: message.senderHandle,
    agentUserId: message.agentUserId,
    at: new Date(message.createdAt),
  });

  if (message.contentType !== "text" || message.text === undefined) {
    console.log(
      `[agent] inbound ${message.contentType ?? "unknown"} from ${message.spaceId} — noted, no reply`,
    );
    return;
  }

  console.log(`[agent] inbound from ${message.spaceId}: ${message.text.length} char(s)`);
  const command = parseCommand(message.text);
  try {
    if (command) {
      // Commands are handled before the model ever sees them, so a wedged or
      // rate-limited model can never cost you control of the heartbeat.
      await handleCommand(message, known, command);
    } else if (llm) {
      await converse(message, known, llm);
    } else {
      await reply(message, HELP);
    }
  } catch (error) {
    const code = problemCode(error);
    console.error(
      `[agent] reply to ${message.spaceId} failed${code ? ` [${code}]` : ""}: ${describe(error)}`,
    );
  }
}

let polling = false;

async function pollOnce(): Promise<void> {
  // A slow poll must not overlap the next one and double-process a message.
  if (polling) return;
  polling = true;
  try {
    // The cursor is inclusive, so start a fresh run from now rather than
    // replaying the whole history of the project on first launch.
    const since = store.cursor() ?? new Date().toISOString();
    const messages = await transport.poll(since);
    for (const message of messages) {
      await handleInbound(message);
      // Advance past this message: +1ms, because createdSince is inclusive and
      // would otherwise hand it back forever.
      store.setCursor(new Date(Date.parse(message.createdAt) + 1).toISOString());
    }
    if (!store.cursor()) store.setCursor(since);
  } catch (error) {
    // Bad conference wifi must not kill the agent. Log and try again next tick.
    const code = problemCode(error);
    console.warn(`[agent] poll failed${code ? ` [${code}]` : ""}: ${describe(error)}`);
  } finally {
    polling = false;
  }
}

let stopping = false;
let pollTimer: NodeJS.Timeout | undefined;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`\n[agent] ${signal} — shutting down`);
  heartbeat.stop();
  if (pollTimer) clearInterval(pollTimer);
  await store.flush();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`[agent] project ${config.projectId}`);
console.log(
  config.agentLine
    ? `[agent] serving line ${config.agentLine} only`
    : "[agent] serving every line this project holds (set AGENT_LINE to narrow it)",
);
console.log(`[agent] registry ${store.path} (${store.all().length} known chat(s))`);
if (llm) {
  console.log(`[agent] models ${config.models.join(" -> ")}`);
  const paid = Llm.paidLooking(config.models);
  if (paid.length > 0) {
    // OpenRouter bills whichever model answers, so a paid entry behind a free
    // one is charged the moment the free one is rate-limited.
    console.warn(
      `[agent] WARNING: these models are not ':free' and will be billed if they answer: ${paid.join(", ")}`,
    );
  }
} else {
  console.log("[agent] no OPENROUTER_API_KEY — commands and heartbeats only, no conversation");
}
heartbeat.start();

// Prove the credentials work before settling into the poll loop, so a bad key
// is one clear line at startup rather than a warning every few seconds.
try {
  await transport.poll(new Date(Date.now() - 1000).toISOString());
  console.log(`[agent] connected — polling every ${config.pollSeconds}s`);
} catch (error) {
  const code = problemCode(error);
  console.error(
    `[agent] could not reach Photon${code ? ` [${code}]` : ""}: ${describe(error)}`,
  );
  process.exit(1);
}

pollTimer = setInterval(() => void pollOnce(), config.pollSeconds * 1000);
await pollOnce();
