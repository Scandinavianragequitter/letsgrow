import { randomBytes, randomInt } from "node:crypto";
import type { Store } from "../db.js";

// Signing in = proving the phone number is yours by texting a short code to your agent.
// The shared line can't text first anyway, so this text is also what connects you on iMessage.

const TTL = 15 * 60_000;

interface Pending { userId: string; phone: string; code: string; exp: number; verified?: boolean }

export class LoginCodes {
  constructor(private d: { store: Store; now: () => number }) {}

  /** Start a sign-in for this user. The browser keeps `ticket`; the person texts `code`. */
  start(userId: string, phone: string): { ticket: string; code: string } {
    const ticket = randomBytes(18).toString("base64url");
    const code = String(randomInt(1000, 10000));
    this.d.store.setKv(`login:${ticket}`, JSON.stringify({ userId, phone, code, exp: this.d.now() + TTL } satisfies Pending));
    this.d.store.setKv(`login-phone:${phone}`, ticket);
    return { ticket, code };
  }

  /** Called for every inbound text: if it carries this sender's pending code, the sign-in is verified. */
  verifyFromText(phone: string, text: string): boolean {
    const ticket = this.d.store.getKv(`login-phone:${phone}`);
    if (!ticket) return false;
    const p = this.read(ticket);
    if (!p || p.verified || p.exp < this.d.now() || p.phone !== phone) return false;
    if (!new RegExp(`(^|\\D)${p.code}(\\D|$)`).test(text)) return false;
    this.d.store.setKv(`login:${ticket}`, JSON.stringify({ ...p, verified: true }));
    return true;
  }

  /** The browser asks: has my ticket been verified? Returns the user once, then the ticket is used up. */
  claim(ticket: string): string | undefined {
    const p = this.read(ticket);
    if (!p?.verified || p.exp < this.d.now()) return undefined;
    this.d.store.setKv(`login:${ticket}`, JSON.stringify({ ...p, exp: 0 }));
    return p.userId;
  }

  private read(ticket: string): Pending | undefined {
    const raw = this.d.store.getKv(`login:${ticket}`);
    return raw ? (JSON.parse(raw) as Pending) : undefined;
  }
}
