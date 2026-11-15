import type { Hono } from "hono";
import type { Store } from "../db.js";
import type { ConnectorHub } from "../integrations/hub.js";
import type { ConnectLinks } from "../engine/connect.js";
import { authUrl, type GoogleConfig, type GoogleProduct } from "../integrations/google.js";
import { parseHealthPayload } from "../integrations/health.js";
import { dayKey } from "../clock.js";

export interface ConnectDeps {
  store: Store;
  hub: ConnectorHub;
  links: ConnectLinks;
  google?: GoogleConfig;
  now: () => number;
  /** Called when a source is newly connected, e.g. to have the agent say thanks on iMessage. */
  onConnected?: (userId: string, what: string) => Promise<void> | void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** One quiet, centered page in the product's style. */
function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Let'sGrow</title><style>
:root{color-scheme:light}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:17px/1.47 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:560px;margin:0 auto;padding:64px 24px}h1{font-size:34px;line-height:1.1;letter-spacing:-.02em;margin:0 0 8px}
.sub{color:#3b82f6;font-weight:600;font-size:21px;margin:0 0 32px}.card{background:#fff;border-radius:18px;padding:24px;margin:16px 0}
ol{padding-left:20px;margin:0}li{margin:10px 0}code,.url{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f5f5f7;border-radius:8px;padding:10px 12px;display:block;word-break:break-all}
.btn{display:inline-block;background:#1d1d1f;color:#fff;border:0;border-radius:980px;padding:12px 22px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.mute{color:#86868b;font-size:15px}input{width:100%;box-sizing:border-box;font:inherit;padding:12px 14px;border:1px solid #d2d2d7;border-radius:12px;margin:0 0 12px}.ok{font-size:48px}
</style></head><body><main>${body}</main></body></html>`;
}
const done = (what: string) => page("Connected", `<div class="ok">✓</div><h1>${esc(what)} connected.</h1><p class="mute">You can close this tab. Your agent will take it from here.</p>`);
const expired = page("Link expired", `<h1>This link has expired.</h1><p class="mute">Ask your agent for a new one.</p>`);

export function registerConnectRoutes(app: Hono, d: ConnectDeps) {
  // ---------- Google (Calendar, Gmail) ----------
  app.get("/connect/google", (c) => {
    const t = c.req.query("t") ?? "";
    if (!d.links.userFor(t)) return c.html(expired, 410);
    if (!d.google) return c.html(page("Not available", `<h1>Google sign-in isn't set up on this server yet.</h1>`), 503);
    const products: GoogleProduct[] = c.req.query("p") === "gmail" ? ["gmail"] : ["calendar"];
    return c.redirect(authUrl(d.google, products, t));
  });

  app.get("/oauth/google/callback", async (c) => {
    const t = c.req.query("state") ?? "";
    const userId = d.links.userFor(t);
    if (!userId) return c.html(expired, 410);
    if (c.req.query("error")) return c.html(page("Not connected", `<h1>Nothing was connected.</h1><p class="mute">Google said: ${esc(c.req.query("error")!)}</p>`));
    try {
      await d.hub.completeGoogle(userId, c.req.query("code") ?? "");
      const s = d.hub.status(userId);
      const what = [s.google_calendar && "Google Calendar", s.gmail && "Gmail"].filter(Boolean).join(" and ") || "Google";
      void Promise.resolve(d.onConnected?.(userId, what)).catch(() => {});
      return c.html(done(what));
    } catch (err) {
      return c.html(page("Not connected", `<h1>That didn't work.</h1><p class="mute">${esc((err as Error).message)}</p>`), 502);
    }
  });

  // ---------- Apple public calendar link ----------
  app.get("/connect/calendar", (c) => {
    const t = c.req.query("t") ?? "";
    if (!d.links.userFor(t)) return c.html(expired, 410);
    return c.html(page("Connect your calendar", `<h1>Share your calendar.</h1><p class="sub">Only the calendar you pick, read-only.</p>
<div class="card"><ol><li>Open <b>Calendar</b> on your iPhone and tap <b>Calendars</b>.</li><li>Tap <b>ⓘ</b> next to the calendar, e.g. Training.</li>
<li>Turn on <b>Public Calendar</b>, tap <b>Share Link…</b>, and send it to your Let'sGrow chat.</li></ol></div>
<div class="card"><p class="mute">Or paste the link here:</p><form method="post"><input name="url" placeholder="webcal://…" required><button class="btn">Connect</button></form></div>
<p class="mute">Anyone with a public calendar link can see that calendar, so share one that only holds what your agent needs.</p>`));
  });
  app.post("/connect/calendar", async (c) => {
    const t = c.req.query("t") ?? "";
    const userId = d.links.userFor(t);
    if (!userId) return c.html(expired, 410);
    const form = await c.req.parseBody();
    try {
      await d.hub.connectCalendarLink(userId, String(form.url ?? ""));
      void Promise.resolve(d.onConnected?.(userId, "Your calendar")).catch(() => {});
      return c.html(done("Calendar"));
    } catch (err) {
      return c.html(page("Not connected", `<h1>That link didn't work.</h1><p class="mute">${esc((err as Error).message)}</p>`), 400);
    }
  });

  // ---------- Apple Health ----------
  app.get("/connect/health", (c) => {
    const t = c.req.query("t") ?? "";
    const userId = d.links.userFor(t);
    if (!userId) return c.html(expired, 410);
    const url = d.links.healthUploadUrl(userId);
    const shortcut = process.env.HEALTH_SHORTCUT_URL;
    return c.html(page("Connect Apple Health", `<h1>Connect Apple Health.</h1><p class="sub">Once a day, your iPhone sends a few numbers. Nothing else.</p>
${shortcut ? `<div class="card"><p>1. Add the Shortcut:</p><a class="btn" href="${esc(shortcut)}">Add “Let'sGrow Health”</a></div>` : ""}
<div class="card"><p>${shortcut ? "2. When it asks for your address, paste this:" : "Your personal address:"}</p><div class="url" id="u">${esc(url)}</div>
<p><button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('u').textContent);this.textContent='Copied'">Copy</button></p></div>
<div class="card"><p>${shortcut ? "3." : "Then"} In <b>Shortcuts → Automation</b>, add <b>Time of Day</b> at 21:30, daily, <b>Run Immediately</b>, and choose the Let'sGrow Health shortcut.</p></div>
<p class="mute">Keep this address private. Prefer an app? Health Auto Export can send to the same address (REST API, JSON).</p>`));
  });

  app.post("/ingest/health/:token", async (c) => {
    const userId = d.links.healthUser(c.req.param("token"));
    if (!userId) return c.json({ error: "unknown address" }, 404);
    const user = d.store.getUser(userId)!;
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "send JSON" }, 400); }
    try {
      const days = parseHealthPayload(body, dayKey(d.now(), user.tz));
      for (const day of days) for (const [k, v] of Object.entries(day.values)) d.store.setSignal(userId, day.day, k, v);
      const conn = d.store.getConnection<{ token: string; lastPushAt?: number }>(userId, "health")!;
      d.store.setConnection(userId, "health", { ...conn, lastPushAt: d.now() }, d.now());
      if (!conn.lastPushAt) void Promise.resolve(d.onConnected?.(userId, "Apple Health")).catch(() => {});
      return c.json({ ok: true, days: days.map((x) => ({ day: x.day, values: x.values })) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
}
