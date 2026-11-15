// Let'sGrow front end. Plain DOM, no build step. User text is always set via textContent.
const root = document.getElementById("app");
let S = null;          // last server state
let busy = false;
let lastJson = "";
let outbox = [];

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e[k] = v;
    else if (v !== false && v !== undefined) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};

async function api(path, method = "GET", body) {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
async function act(fn) {
  busy = true;
  try { S = await fn(); } catch (e) { alert(e.message); }
  busy = false; await refreshOutbox(); render(true);
}

const SRC = { screen_time: "Screen Time", health: "Health", calendar: "Calendar" };
function describePlan(p) {
  const lines = [];
  if (p.mode === "autonomous") {
    const a = p.autonomous;
    lines.push(`Checks ${SRC[a.source] || a.source} on its own: ${a.metric} ${a.comparator === "lte" ? "≤" : "≥"} ${a.threshold}${a.unit ? " " + a.unit : ""}, evaluated at ${a.evaluateAt}.`);
    lines.push("You don't have to do or report anything.");
  } else {
    for (const r of p.prompted.reminders) {
      if (r.anchor === "calendar_event") {
        const m = Math.abs(r.offsetMinutes), before = r.offsetMinutes < 0;
        lines.push(`${m} min ${before ? "before" : "after"} the ${r.edge} of any “${r.eventKeyword}” on your calendar: “${r.text}”`);
      } else lines.push(`At ${r.time}: “${r.text}”`);
    }
    lines.push(p.prompted.confirmWith === "heart" ? "You confirm with one ❤️ tap." : "You confirm with a one-word reply.");
  }
  if (p.daysOfWeek?.length) lines.push("Days: " + p.daysOfWeek.map((d) => "SunMonTueWedThuFriSat".slice(d * 3, d * 3 + 3)).join(", "));
  return lines;
}

function signupView() {
  const name = h("input", { id: "su-name", placeholder: "First name", autocomplete: "given-name" });
  const phone = h("input", { id: "su-phone", placeholder: "Your iMessage number, e.g. +1 555 123 4567", type: "tel" });
  const err = h("div", { class: "err" });
  const go = h("button", { onclick: async () => {
    err.textContent = "";
    try { S = await api("/api/signup", "POST", { name: name.value, phone: phone.value }); if (S.warning) alert(S.warning); render(true); }
    catch (e) { err.textContent = e.message; }
  } }, "Get started");
  root.replaceChildren(h("div", { class: "center" },
    h("h1", {}, "Grow one habit."),
    h("p", { class: "mute" }, "Tell an agent the habit you want. It works out how to check on you with the least hassle, and a friend's agent has your back if you slip."),
    h("div", { class: "card" }, h("label", {}, "Name"), name, h("label", {}, "Phone (iMessage)"), phone, h("div", { class: "row" }, go), err)));
}

function chatCard() {
  const log = h("div", { class: "chat", id: "chatlog" });
  if (!S.chat.length) log.append(h("div", { class: "bubble assistant" }, `Hi ${S.user.name}! What healthy habit do you want to build? For example: “I want to spend less time on Instagram, under an hour a day” or “I want to stretch before and after every training”.`));
  for (const m of S.chat) log.append(h("div", { class: `bubble ${m.role}` }, m.content, m.channel === "imessage" ? h("div", { class: "via" }, "iMessage") : null));
  const input = h("input", { id: "msg", placeholder: S.habit?.status === "active" ? "Ask about your progress, change the plan…" : "Describe your habit…" });
  const send = async () => {
    const t = input.value.trim(); if (!t || busy) return;
    input.value = ""; S.chat.push({ role: "user", content: t }); render(true);
    log.append(h("div", { class: "bubble assistant mute" }, "thinking…"));
    await act(() => api("/api/chat", "POST", { message: t }));
  };
  input.onkeydown = (e) => { if (e.key === "Enter") send(); };
  queueMicrotask(() => { log.scrollTop = log.scrollHeight; });
  return h("div", { class: "card" }, h("h2", {}, "Your habit agent"), log, h("div", { class: "row" }, input, h("button", { onclick: send }, "Send")));
}

function planCard() {
  const p = S.plan, hab = S.habit;
  if (!p) return h("div", { class: "card" }, h("h2", {}, "Plan"), h("p", { class: "mute" }, "Once you describe your habit, the agent will show how it plans to verify it here."));
  const card = h("div", { class: "card plan" },
    h("h2", {}, "The plan"),
    h("h3", {}, p.title), h("span", { class: "pill" }, p.mode === "autonomous" ? "Automatic verification" : "Light-touch reminders"),
    h("ul", {}, describePlan(p).map((l) => h("li", {}, l))));
  if (hab.status === "planning") {
    card.append(escalationSelect(), h("div", { class: "row" }, h("button", { onclick: () => act(() => api("/api/habit/start", "POST")) }, `Start my ${hab.durationDays} days`)),
      h("p", { class: "mute" }, "Want changes? Just tell the agent in the chat."));
  }
  return card;
}

function escalationSelect() {
  const e = S.habit.escalation;
  const current = S.presets.find((p) => JSON.stringify(p.policy) === JSON.stringify(e));
  const sel = h("select", { onchange: () => sel.value && act(() => api("/api/habit/escalation", "PATCH", { preset: sel.value })) },
    current ? null : h("option", { value: "", selected: true }, `Custom (tell friend after ${e.missedDaysBeforeNudge} missed day${e.missedDaysBeforeNudge > 1 ? "s" : ""})`),
    S.presets.map((p) => h("option", { value: p.id, selected: current?.id === p.id }, p.label)));
  return h("div", {}, h("label", {}, "How fast should your friend's agent tell on you?"), sel);
}

function progressCard() {
  const hab = S.habit, st = S.stats;
  const map = new Map(S.days.map((d) => [d.day, d]));
  const dots = h("div", { class: "dots" });
  const start = new Date(hab.startDay + "T00:00:00Z");
  let dayNo = 0;
  for (let i = 0; i < hab.durationDays; i++) {
    const d = new Date(start.getTime() + i * 864e5).toISOString().slice(0, 10);
    const rec = map.get(d);
    if (d <= S.now.day) dayNo = i + 1;
    dots.append(h("div", { class: `dot ${rec ? rec.status : ""} ${d === S.now.day ? "today" : ""}`, title: `${d}${rec ? ": " + rec.status + (rec.detail ? " (" + rec.detail + ")" : "") : ""}` }));
  }
  const done = hab.status === "completed";
  return h("div", { class: "card" },
    h("h2", {}, done ? "Finished 🎉" : `Day ${Math.min(dayNo, hab.durationDays)} of ${hab.durationDays}`), dots,
    h("div", { class: "stats" },
      h("div", {}, h("b", {}, st.done), "on target"), h("div", {}, h("b", {}, st.missed), "missed"),
      h("div", {}, h("b", {}, st.longestStreak), "best streak"), h("div", {}, h("b", {}, st.currentMissStreak), "misses in a row")));
}

function friendsCard() {
  const inv = S.invite;
  const card = h("div", { class: "card" }, h("h2", {}, "Your friends"));
  card.append(h("p", { class: "mute" }, "Send this link in iMessage. Whoever opens it gets their own agent that texts them only if you slip."));
  card.append(h("div", { class: "link" }, inv.url));
  card.append(h("div", { class: "qrwrap" }, h("img", { class: "qr", src: `/qr.svg?text=${encodeURIComponent(inv.url)}`, alt: "QR code for your invite link" }),
    h("span", { class: "mute" }, "Or let them scan this with their phone camera.")));
  card.append(h("div", { class: "row" },
    h("a", { class: "btn", href: inv.sms }, "Send in iMessage"),
    h("button", { class: "ghost", onclick: async (e) => { await navigator.clipboard.writeText(inv.text); e.target.textContent = "Copied"; } }, "Copy message")));
  if (!S.friends.length) card.append(h("p", { class: "mute" }, "Nobody has joined yet."));
  for (const f of S.friends) card.append(h("div", { class: "friend" }, h("span", {}, f.name, " ", h("span", { class: "mute" }, f.state === "active" ? "" : "(waiting for their first text)")), h("span", { class: "mute" }, `asked ${f.nudges}× · replied ${f.replies}×`)));
  card.append(escalationSelect());
  return card;
}

function connectionsCard() {
  const c = S.connectors;
  if (!c) return null;
  const rows = [
    ["google_calendar", "Google Calendar", c.google_calendar, c.google_configured],
    ["apple_calendar", "Apple Calendar", c.apple_calendar, true],
    ["apple_health", "Apple Health", c.apple_health, true],
    ["gmail", "Gmail", c.gmail, c.google_configured],
  ];
  const open = async (id) => { const r = await api("/api/connect-link", "POST", { connector: id }); window.open(r.link, "_blank"); };
  return h("div", { class: "card" }, h("h2", {}, "Connections"),
    h("p", { class: "mute" }, "Real data replaces demo data as soon as a source is connected."),
    ...rows.map(([id, label, on, available]) => h("div", { class: "conn" },
      h("span", {}, h("span", { class: on ? "dot on" : "dot" }), label),
      on ? h("span", { class: "mute" }, "Connected")
        : available ? h("button", { class: "ghost", onclick: () => open(id) }, "Connect")
        : h("span", { class: "mute" }, "Not set up"))));
}

function connectBanner() {
  if (S.warning) return h("div", { class: "banner warn" }, S.warning);
  if (S.user.connected) return null;
  return h("div", { class: "banner warn" }, h("b", {}, "One step: "), `text “hi” to ${S.line.number} from iMessage so I can reach you. `,
    h("a", { href: S.line.sms }, "Open Messages"), S.messengerMode === "console" ? " (demo mode: use the dev panel's “Connect me” instead)" : "");
}

async function refreshOutbox() { if (S?.dev) { try { outbox = await api("/api/dev/outbox"); } catch {} } }

function devPanel() {
  const call = (path, body) => act(() => api(path, "POST", body));
  const key = h("input", { value: "app_minutes:Instagram", size: 22 }), val = h("input", { value: "95", size: 5 });
  const evT = h("input", { value: "Training", size: 10 }), evS = h("input", { value: "18:00", size: 5 }), evE = h("input", { value: "19:30", size: 5 });
  const fsel = h("select", {}, S.friends.map((f) => h("option", { value: f.phone }, f.name)));
  const ftext = h("input", { placeholder: "friend replies…", size: 20 });
  const box = h("div", { class: "outbox" }, outbox.length ? outbox.map((m) => h("div", {}, h("b", {}, m.direction === "out" ? `→ ${m.handle}: ` : `← ${m.handle}: `), m.body)) : "No messages yet.");
  queueMicrotask(() => { box.scrollTop = box.scrollHeight; });
  const me = S.user.phone;
  return h("details", { class: "dev", open: localStorage.devopen === "1", ontoggle: (e) => { localStorage.devopen = e.target.open ? "1" : "0"; } },
    h("summary", {}, "Demo controls"),
    h("div", { class: "grp" }, h("b", {}, "Time"),
      h("button", { class: "small ghost", onclick: () => call("/api/dev/skip", { days: 1 }) }, "+1 day"),
      h("button", { class: "small ghost", onclick: () => call("/api/dev/skip", { days: 7 }) }, "+7 days"),
      h("button", { class: "small ghost", onclick: () => call("/api/dev/skip", { days: 30 }) }, "+30 days"),
      h("button", { class: "small ghost", onclick: () => call("/api/dev/tick") }, "Run tick")),
    h("div", { class: "grp" }, h("b", {}, "You"),
      h("button", { class: "small ghost", onclick: () => call("/api/dev/inbound", { handle: me, kind: "text", text: "hi" }) }, "Connect me (text hi)"),
      h("button", { class: "small ghost", onclick: () => call("/api/dev/inbound", { handle: me, kind: "reaction", emoji: "❤️" }) }, "React ❤️ to latest reminder")),
    h("div", { class: "grp" }, h("b", {}, "Screen time / health"), key, "=", val,
      h("button", { class: "small ghost", onclick: () => call("/api/dev/signal", { key: key.value, value: Number(val.value) }) }, "Set for today")),
    h("div", { class: "grp" }, h("b", {}, "Calendar"), evT, evS, "to", evE,
      h("button", { class: "small ghost", onclick: () => call("/api/dev/event", { title: evT.value, start: evS.value, end: evE.value }) }, "Add today")),
    S.friends.length ? h("div", { class: "grp" }, h("b", {}, "Friend"), fsel,
      h("button", { class: "small ghost", onclick: () => call("/api/dev/inbound", { handle: fsel.value, kind: "text", text: "ping" }) }, "Texts “ping”"), ftext,
      h("button", { class: "small ghost", onclick: () => ftext.value && call("/api/dev/inbound", { handle: fsel.value, kind: "text", text: ftext.value }) }, "Send")) : null,
    h("div", { class: "grp" }, h("b", {}, "iMessage log (demo mode)")), box);
}

function render(force) {
  if (!S || !S.user) {
    // Build the signup form once; rebuilding it on every poll wiped what the user typed.
    if (!document.getElementById("su-name")) signupView();
    lastJson = null;
    return;
  }
  const json = JSON.stringify([S, outbox]);
  if (!force && json === lastJson) return;
  lastJson = json;
  const saved = document.getElementById("msg")?.value ?? "";
  const focused = document.activeElement?.id === "msg";
  const hab = S.habit;
  const right = [];
  if (!hab || hab.status === "planning") right.push(planCard(), connectionsCard());
  else {
    right.push(planCard(), progressCard());
    if (hab.status === "active" || hab.status === "completed") right.push(friendsCard());
    right.push(connectionsCard());
    right.push(h("button", { class: "ghost", onclick: () => confirm("Start over with a new habit?") && act(() => api("/api/habit/restart", "POST")) }, "Start over"));
  }
  const who = h("div", { class: "mute", style: "text-align:right;font-size:13px" }, `Signed in as ${S.user.name} (${S.user.phone}) · `,
    h("a", { href: "#", onclick: async (e) => { e.preventDefault(); await api("/api/logout", "POST"); location.reload(); } }, "Sign out"));
  root.replaceChildren(who, connectBanner(), h("div", { class: "grid" }, chatCard(), h("div", {}, right)), S.dev ? devPanel() : null);
  const m = document.getElementById("msg");
  if (m && saved) { m.value = saved; if (focused) m.focus(); }
}

async function poll() {
  if (busy) return;
  try { S = await api("/api/state"); await refreshOutbox(); render(false); } catch {}
}
(async () => { await poll(); render(true); setInterval(poll, 4000); })();
