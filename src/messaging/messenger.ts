import type { Store } from "../db.js";

export interface InboundEvent {
  /** E.164 phone or email of the sender. */
  handle: string;
  kind: "text" | "reaction" | "other";
  text?: string;
  emoji?: string;
}
export type InboundHandler = (e: InboundEvent) => Promise<void>;

export interface Messenger {
  readonly mode: "console" | "photon";
  send(handle: string, body: string): Promise<void>;
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
  async start(onInbound: InboundHandler) { this.handler = onInbound; }
  async stop() {}
  /** Used by the dev panel to pretend a phone texted the line. */
  async simulateInbound(e: InboundEvent) {
    this.store.logMessage("in", e.handle, e.kind === "reaction" ? `(reaction ${e.emoji})` : (e.text ?? ""), this.now());
    await this.handler?.(e);
  }
}
