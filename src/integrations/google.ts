import type { CalEvent } from "./mock.js";

// Google sign-in (OAuth 2.0, web server flow) plus the two read-only APIs we use.
// Plain fetch, no Google SDK: three endpoints are all we need.

export const SCOPES = {
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
} as const;
export type GoogleProduct = keyof typeof SCOPES;

export interface GoogleConfig { clientId: string; clientSecret: string; redirectUri: string }
export interface GoogleTokens { access_token: string; refresh_token?: string; expires_at: number; scope: string }

export function authUrl(cfg: GoogleConfig, products: GoogleProduct[], state: string): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: products.map((x) => SCOPES[x]).join(" "),
    access_type: "offline",          // get a refresh token so access keeps working
    prompt: "consent",
    include_granted_scopes: "true",  // adding Gmail later keeps Calendar
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(body: Record<string, string>, fetchImpl: typeof fetch): Promise<any> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`Google sign-in failed: ${json.error_description ?? json.error ?? res.status}`);
  return json;
}

export async function exchangeCode(cfg: GoogleConfig, code: string, now: number, fetchImpl: typeof fetch = fetch): Promise<GoogleTokens> {
  const j = await tokenRequest({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: "authorization_code" }, fetchImpl);
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: now + (j.expires_in ?? 3600) * 1000, scope: j.scope ?? "" };
}

/** Returns valid tokens, refreshing if needed. Caller saves the result. */
export async function freshTokens(cfg: GoogleConfig, t: GoogleTokens, now: number, fetchImpl: typeof fetch = fetch): Promise<GoogleTokens> {
  if (t.expires_at - 60_000 > now) return t;
  if (!t.refresh_token) throw new Error("Google access expired and there is no refresh token. Connect Google again.");
  const j = await tokenRequest({ refresh_token: t.refresh_token, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "refresh_token" }, fetchImpl);
  return { ...t, access_token: j.access_token, expires_at: now + (j.expires_in ?? 3600) * 1000, scope: j.scope ?? t.scope };
}

export const hasScope = (t: GoogleTokens | undefined, product: GoogleProduct) => !!t && t.scope.split(" ").includes(SCOPES[product]);

async function api(token: string, url: string, fetchImpl: typeof fetch): Promise<any> {
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`Google API ${res.status}: ${json.error?.message ?? res.statusText}`);
  return json;
}

/** Timed events from all the user's selected calendars in [fromMs, toMs). All-day events are skipped. */
export async function calendarEvents(token: string, fromMs: number, toMs: number, fetchImpl: typeof fetch = fetch): Promise<CalEvent[]> {
  const list = await api(token, "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader", fetchImpl);
  const cals = (list.items ?? []).filter((c: any) => c.selected !== false && !c.hidden);
  const out: CalEvent[] = [];
  for (const c of cals) {
    const q = new URLSearchParams({ timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
    const ev = await api(token, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?${q}`, fetchImpl);
    for (const e of ev.items ?? []) {
      if (e.status === "cancelled" || !e.start?.dateTime || !e.end?.dateTime) continue;
      out.push({ title: e.summary ?? "(untitled)", startMs: Date.parse(e.start.dateTime), endMs: Date.parse(e.end.dateTime) });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

export interface MailHit { from: string; subject: string; date: string; snippet: string }

/** Gmail search (same syntax as the Gmail search box). Metadata and snippets only, never full bodies. */
export async function searchMail(token: string, query: string, max = 10, fetchImpl: typeof fetch = fetch): Promise<{ count: number; messages: MailHit[] }> {
  const q = new URLSearchParams({ q: query, maxResults: String(Math.min(max, 50)) });
  const list = await api(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages?${q}`, fetchImpl);
  const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
  const messages: MailHit[] = [];
  for (const id of ids.slice(0, max)) {
    const m = await api(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, fetchImpl);
    const h = (name: string) => (m.payload?.headers ?? []).find((x: any) => x.name.toLowerCase() === name.toLowerCase())?.value ?? "";
    messages.push({ from: h("From"), subject: h("Subject"), date: h("Date"), snippet: m.snippet ?? "" });
  }
  return { count: ids.length, messages };
}

/** Gmail query limited to one local day, using Unix-second bounds (Gmail supports after:/before: with epochs). */
export function dayQuery(query: string, dayStartMs: number, dayEndMs: number) {
  return `(${query}) after:${Math.floor(dayStartMs / 1000)} before:${Math.floor(dayEndMs / 1000)}`;
}
