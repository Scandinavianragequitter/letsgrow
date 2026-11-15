import { randomBytes } from "node:crypto";
import type { Store } from "../db.js";

// Personal one-time links the agent sends so connecting a source is one tap.

export type Connector = "google_calendar" | "gmail" | "apple_health" | "apple_calendar";
const TTL = 24 * 3_600_000;

export class ConnectLinks {
  constructor(private d: { store: Store; publicBaseUrl: string; googleRedirectUri?: string; now: () => number }) {}

  /** A short-lived token that identifies the user on a connect page. */
  token(userId: string): string {
    const t = randomBytes(12).toString("base64url");
    this.d.store.setKv(`connect:${t}`, JSON.stringify({ userId, exp: this.d.now() + TTL }));
    return t;
  }
  userFor(token: string): string | undefined {
    const raw = this.d.store.getKv(`connect:${token}`);
    if (!raw) return undefined;
    const { userId, exp } = JSON.parse(raw) as { userId: string; exp: number };
    return exp > this.d.now() ? userId : undefined;
  }

  /** Permanent upload address for a user's Apple Health data. */
  healthToken(userId: string): string {
    const existing = this.d.store.getConnection<{ token: string }>(userId, "health");
    if (existing?.token) return existing.token;
    const t = randomBytes(18).toString("base64url");
    this.d.store.setConnection(userId, "health", { token: t }, this.d.now());
    this.d.store.setKv(`health:${t}`, userId);
    return t;
  }
  healthUser(token: string) { return this.d.store.getKv(`health:${token}`); }
  healthUploadUrl(userId: string) { return `${this.d.publicBaseUrl}/ingest/health/${this.healthToken(userId)}`; }

  link(userId: string, c: Connector) {
    const base = this.d.publicBaseUrl;
    const t = this.token(userId);
    if (c === "google_calendar" || c === "gmail") {
      const laptopOnly = !!this.d.googleRedirectUri && /^http:\/\/(localhost|127\.0\.0\.1)/.test(this.d.googleRedirectUri);
      return {
        link: `${base}/connect/google?t=${t}&p=${c === "gmail" ? "gmail" : "calendar"}`,
        whatTheyDo: "Tap the link, pick their Google account, tap Allow. Read-only.",
        note: laptopOnly ? "Google sign-in currently returns to localhost, so they must open this link on the laptop running Let'sGrow, not on their phone." : undefined,
      };
    }
    if (c === "apple_health") {
      return { link: `${base}/connect/health?t=${t}`, whatTheyDo: "Open on their iPhone, add the Shortcut, turn on the daily automation (one time, about a minute)." };
    }
    return {
      link: `${base}/connect/calendar?t=${t}`,
      whatTheyDo: "In the iPhone Calendar app: Calendars, tap (i) next to the calendar, turn on Public Calendar, Share Link, send it to you here. Or paste it on the page.",
    };
  }
}
