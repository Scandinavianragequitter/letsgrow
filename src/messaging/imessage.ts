import { Spectrum, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { InboundHandler, Messenger } from "./messenger.js";

/** Real iMessage through Photon Spectrum (project ID + secret). */
export async function createPhotonMessenger(projectId: string, projectSecret: string): Promise<Messenger> {
  const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
  const im = imessage(app);
  // Reuse a conversation once we have one for a handle (also covers inbound-first chats).
  const spaces = new Map<string, { send: (c: ReturnType<typeof text>) => Promise<unknown> }>();
  let stopped = false;

  return {
    mode: "photon",
    async send(handle, body) {
      let space = spaces.get(handle);
      if (!space) {
        const user = await im.user(handle);
        space = (await im.space.create(user)) as unknown as typeof space;
        spaces.set(handle, space!);
      }
      await space!.send(text(body));
    },
    async start(onInbound: InboundHandler) {
      void (async () => {
        for await (const [space, message] of app.messages) {
          if (stopped) break;
          if (message.direction !== "inbound" || message.platform !== "imessage") continue;
          const sender = imessage(message).sender;
          const handle = sender?.address ?? message.sender?.id;
          if (!handle) continue;
          spaces.set(handle, space as unknown as { send: (c: ReturnType<typeof text>) => Promise<unknown> });
          const c = message.content;
          try {
            if (c.type === "text") await onInbound({ handle, kind: "text", text: c.text });
            else if (c.type === "reaction") await onInbound({ handle, kind: "reaction", emoji: c.emoji });
            else await onInbound({ handle, kind: "other" });
          } catch (err) {
            console.error("inbound handler failed:", err);
          }
        }
      })();
    },
    async stop() {
      stopped = true;
      await app.stop();
    },
  };
}
