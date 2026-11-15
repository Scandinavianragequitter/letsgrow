import type { Store } from "../db.js";

export interface InboundImage { mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string /* base64 */ }

export interface InboundEvent {
  /** E.164 phone or email of the sender. */
  handle: string;
  kind: "text" | "reaction" | "image" | "other";
  text?: string;
  emoji?: string;
  /** For kind "image": the photo(s), ready for the model. `text` holds a caption if one was sent. */
  images?: InboundImage[];
}
export type InboundHandler = (e: InboundEvent) => Promise<void>;

export interface Messenger {
  readonly mode: "console" | "photon";
  send(handle: string, body: string): Promise<void>;
  /** Send a PNG (e.g. the day-60 card). */
  sendImage?(handle: string, png: Buffer, caption?: string): Promise<void>;
  /** Show or hide the "…" typing bubble in this person's conversation. Best effort. */
  typing?(handle: string, on: boolean): Promise<void>;
  start(onInbound: InboundHandler): Promise<void>;
  stop(): Promise<void>;
}

/** No real texts: messages land in an in-app outbox so the whole product can be demoed locally. */
export class ConsoleMessenger implements Messenger {
  readonly mode = "console" as const;
  private handler: InboundHandler | undefined;
  constructor(private store: Store, private now: () => number) {}
  async send(handle: string, body: string) {
    this.store.logMessage("out", handle, body, this.now());
    console.log(`[imessage:out -> ${handle}] ${body}`);
  }
  async sendImage(handle: string, png: Buffer, caption?: string) {
    // No phone in console mode: keep the image so the dev panel can show it (/api/dev/image/<name>).
    const name = `img-${this.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.store.setKv(`image:${name}`, png.toString("base64"));
    this.store.logMessage("out", handle, `[image ${name}]${caption ? ` ${caption}` : ""}`, this.now());
    console.log(`[imessage:out -> ${handle}] (image ${name}, ${Math.round(png.length / 1024)} KB)`);
  }
  async start(onInbound: InboundHandler) { this.handler = onInbound; }
  async stop() {}
  /** Used by the dev panel to pretend a phone texted the line. */
  async simulateInbound(e: InboundEvent) {
    this.store.logMessage("in", e.handle, e.kind === "reaction" ? `(reaction ${e.emoji})` : e.kind === "image" ? `(photo) ${e.text ?? ""}` : (e.text ?? ""), this.now());
    await this.handler?.(e);
  }
}
