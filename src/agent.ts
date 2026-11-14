import { Spectrum, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

const app = await Spectrum({
  projectId: need("PROJECT_ID"),
  projectSecret: need("PROJECT_SECRET"),
  providers: [imessage.config()],
});

// Spaces (chats) that have messaged the agent. On a shared iMessage line the
// agent may only text people who have messaged it first, so we only ever
// heartbeat these.
const known = new Map<string, Parameters<typeof lastSend>[0]>();
async function lastSend(space: { send: (c: ReturnType<typeof text>) => Promise<unknown> }, body: string) {
  await space.send(text(body));
}

const minutes = Number(process.env.HEARTBEAT_MINUTES ?? "60");
let timer: NodeJS.Timeout | undefined;
if (minutes > 0) {
  timer = setInterval(async () => {
    const stamp = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    for (const [id, space] of known) {
      try {
        await lastSend(space, `Heartbeat ${stamp}: agent is up.`);
      } catch (err) {
        console.error(`heartbeat to ${id} failed:`, err);
      }
    }
  }, minutes * 60_000);
}

async function shutdown() {
  if (timer) clearInterval(timer);
  await app.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Agent running. Text the shared line to talk to it.");

for await (const [space, message] of app.messages) {
  if (message.direction !== "inbound") continue;
  known.set(space.id, space);

  const content = message.content;
  const body = content.type === "text" ? content.text : undefined;
  console.log(`[${space.id}] ${body ?? `(${content.type})`}`);

  if (body) {
    await space.send(text(`You said: ${body}`));
  }
}
