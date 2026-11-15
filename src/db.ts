import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export type HabitStatus = "planning" | "active" | "completed" | "cancelled";
export type DayStatus = "done" | "missed" | "na" | "unknown";

export interface UserRow { id: string; name: string; phone: string; tz: string; connected: number; created_at: number }
export interface HabitRow {
  id: string; user_id: string; description: string; plan_json: string | null; status: HabitStatus;
  start_day: string | null; duration_days: number; escalation_json: string; invite_token: string;
  started_at: number | null; completed_at: number | null; created_at: number;
}
export interface DayRow { habit_id: string; day: string; status: DayStatus; detail: string | null; resolved_at: number }
export interface ReminderRow {
  id: number; habit_id: string; day: string; due_at: number; text: string;
  sent_at: number | null; deadline_at: number; confirmed_at: number | null;
  /** Which calendar event (or fixed slot) this reminder is for, so a re-plan can add or drop exactly the right ones. */
  event_key: string | null;
}
export interface FriendRow {
  id: string; habit_id: string; name: string; phone: string; state: "assigned" | "active";
  assigned_number: string | null; created_at: number; joined_at: number | null;
}
export interface FriendEventRow { id: number; habit_id: string; friend_id: string; kind: string; day: string | null; body: string | null; created_at: number }
export interface NudgeRow { id: number; habit_id: string; day: string; send_at: number; sent_at: number | null; note: string | null }
export interface ChatRow { id: number; user_id: string; role: "user" | "assistant"; content: string; created_at: number; channel: "web" | "imessage" }
export interface OutboxRow { id: number; direction: "out" | "in"; handle: string; body: string; created_at: number }

export const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    try { this.db.exec("ALTER TABLE chat ADD COLUMN channel TEXT NOT NULL DEFAULT 'web'"); } catch { /* already there */ }
    try { this.db.exec("ALTER TABLE synced_events ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }
    try { this.db.exec("ALTER TABLE reminders ADD COLUMN event_key TEXT"); } catch { /* already there */ }
  }
  private all<T>(sql: string, ...p: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...p) as T[];
  }
  private get<T>(sql: string, ...p: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...p) as T | undefined;
  }
  private run(sql: string, ...p: (string | number | null)[]) {
    return this.db.prepare(sql).run(...p);
  }

  // users & sessions
  createUser(name: string, phone: string, tz: string, now: number): UserRow {
    const id = newId("usr");
    this.run("INSERT INTO users(id,name,phone,tz,created_at) VALUES(?,?,?,?,?)", id, name, phone, tz, now);
    return this.getUser(id)!;
  }
  getUser(id: string) { return this.get<UserRow>("SELECT * FROM users WHERE id=?", id); }
  getUserByPhone(phone: string) { return this.get<UserRow>("SELECT * FROM users WHERE phone=?", phone); }
  markUserConnected(id: string) { this.run("UPDATE users SET connected=1 WHERE id=?", id); }
  createSession(userId: string): string {
    const t = randomBytes(24).toString("hex");
    this.run("INSERT INTO sessions(token,user_id) VALUES(?,?)", t, userId);
    return t;
  }
  userForSession(token: string) {
    const r = this.get<{ user_id: string }>("SELECT user_id FROM sessions WHERE token=?", token);
    return r ? this.getUser(r.user_id) : undefined;
  }

  // habits
  createHabit(userId: string, description: string, durationDays: number, escalationJson: string, now: number): HabitRow {
    const id = newId("hab");
    this.run(
      "INSERT INTO habits(id,user_id,description,status,duration_days,escalation_json,invite_token,created_at) VALUES(?,?,?,?,?,?,?,?)",
      id, userId, description, "planning", durationDays, escalationJson, randomBytes(9).toString("base64url"), now,
    );
    return this.getHabit(id)!;
  }
  getHabit(id: string) { return this.get<HabitRow>("SELECT * FROM habits WHERE id=?", id); }
  getHabitByToken(t: string) { return this.get<HabitRow>("SELECT * FROM habits WHERE invite_token=?", t); }
  currentHabit(userId: string) {
    return this.get<HabitRow>(
      "SELECT * FROM habits WHERE user_id=? AND status IN ('planning','active','completed') ORDER BY created_at DESC LIMIT 1", userId);
  }
  activeHabits() { return this.all<HabitRow>("SELECT * FROM habits WHERE status='active'"); }
  setPlan(id: string, planJson: string, description?: string) {
    this.run("UPDATE habits SET plan_json=?, description=COALESCE(?,description) WHERE id=?", planJson, description ?? null, id);
  }
  activateHabit(id: string, startDay: string, now: number) {
    this.run("UPDATE habits SET status='active', start_day=?, started_at=? WHERE id=?", startDay, now, id);
  }
  setHabitStatus(id: string, status: HabitStatus, now?: number) {
    this.run("UPDATE habits SET status=?, completed_at=COALESCE(?,completed_at) WHERE id=?", status, now ?? null, id);
  }
  setEscalation(id: string, json: string) { this.run("UPDATE habits SET escalation_json=? WHERE id=?", json, id); }

  // chat
  /** One conversation thread per party (a user id or a friend id), across the website and iMessage. */
  addChat(partyId: string, role: "user" | "assistant", content: string, now: number, channel: "web" | "imessage" = "web") {
    this.run("INSERT INTO chat(user_id,role,content,created_at,channel) VALUES(?,?,?,?,?)", partyId, role, content, now, channel);
  }
  chat(userId: string, limit = 40) {
    return this.all<ChatRow>("SELECT * FROM (SELECT * FROM chat WHERE user_id=? ORDER BY id DESC LIMIT ?) ORDER BY id", userId, limit);
  }
  clearChat(userId: string) { this.run("DELETE FROM chat WHERE user_id=?", userId); }

  // day log
  getDay(habitId: string, day: string) { return this.get<DayRow>("SELECT * FROM day_log WHERE habit_id=? AND day=?", habitId, day); }
  setDay(habitId: string, day: string, status: DayStatus, detail: string | null, now: number) {
    this.run("INSERT OR REPLACE INTO day_log(habit_id,day,status,detail,resolved_at) VALUES(?,?,?,?,?)", habitId, day, status, detail, now);
  }
  days(habitId: string) { return this.all<DayRow>("SELECT * FROM day_log WHERE habit_id=? ORDER BY day", habitId); }
  /** Remove days written by the presenter's simulated slip, so a real run's record stays honest. */
  clearSimulatedDays(habitId: string) { this.run("DELETE FROM day_log WHERE habit_id=? AND detail LIKE 'simulated%'", habitId); }

  // reminders
  addReminder(r: Omit<ReminderRow, "id" | "sent_at" | "confirmed_at" | "event_key"> & { event_key?: string | null }) {
    this.run("INSERT INTO reminders(habit_id,day,due_at,text,deadline_at,event_key) VALUES(?,?,?,?,?,?)", r.habit_id, r.day, r.due_at, r.text, r.deadline_at, r.event_key ?? null);
  }
  deleteReminder(id: number) { this.run("DELETE FROM reminders WHERE id=? AND sent_at IS NULL", id); }
  remindersForDay(habitId: string, day: string) {
    return this.all<ReminderRow>("SELECT * FROM reminders WHERE habit_id=? AND day=? ORDER BY due_at", habitId, day);
  }
  hasMaterialized(habitId: string, day: string) {
    return !!this.get("SELECT 1 AS x FROM materialized WHERE habit_id=? AND day=?", habitId, day);
  }
  markMaterialized(habitId: string, day: string) { this.run("INSERT OR IGNORE INTO materialized(habit_id,day) VALUES(?,?)", habitId, day); }
  dueUnsentReminders(habitId: string, now: number) {
    return this.all<ReminderRow>("SELECT * FROM reminders WHERE habit_id=? AND sent_at IS NULL AND due_at<=? ORDER BY due_at", habitId, now);
  }
  markReminderSent(id: number, now: number) { this.run("UPDATE reminders SET sent_at=? WHERE id=?", now, id); }
  oldestPendingReminder(habitId: string) {
    return this.get<ReminderRow>(
      "SELECT * FROM reminders WHERE habit_id=? AND sent_at IS NOT NULL AND confirmed_at IS NULL ORDER BY sent_at LIMIT 1", habitId);
  }
  confirmReminder(id: number, now: number) { this.run("UPDATE reminders SET confirmed_at=? WHERE id=?", now, id); }
  pendingReminders(habitId: string) {
    return this.all<ReminderRow>("SELECT * FROM reminders WHERE habit_id=? AND sent_at IS NOT NULL AND confirmed_at IS NULL", habitId);
  }

  // friends
  addFriend(habitId: string, name: string, phone: string, assigned: string | null, now: number): FriendRow {
    const existing = this.get<FriendRow>("SELECT * FROM friends WHERE habit_id=? AND phone=?", habitId, phone);
    if (existing) return existing;
    const id = newId("frd");
    this.run("INSERT INTO friends(id,habit_id,name,phone,state,assigned_number,created_at) VALUES(?,?,?,?,?,?,?)",
      id, habitId, name, phone, "assigned", assigned, now);
    return this.get<FriendRow>("SELECT * FROM friends WHERE id=?", id)!;
  }
  friends(habitId: string) { return this.all<FriendRow>("SELECT * FROM friends WHERE habit_id=? ORDER BY created_at", habitId); }
  friendsByPhone(phone: string) { return this.all<FriendRow>("SELECT * FROM friends WHERE phone=? ORDER BY created_at DESC", phone); }
  activateFriend(id: string, now: number) { this.run("UPDATE friends SET state='active', joined_at=? WHERE id=?", now, id); }
  addFriendEvent(habitId: string, friendId: string, kind: string, day: string | null, body: string | null, now: number) {
    this.run("INSERT INTO friend_events(habit_id,friend_id,kind,day,body,created_at) VALUES(?,?,?,?,?,?)", habitId, friendId, kind, day, body, now);
  }
  friendEvents(habitId: string) { return this.all<FriendEventRow>("SELECT * FROM friend_events WHERE habit_id=? ORDER BY id", habitId); }

  // nudges
  addPendingNudge(habitId: string, day: string, sendAt: number, note: string) {
    this.run("INSERT INTO pending_nudges(habit_id,day,send_at,note) VALUES(?,?,?,?)", habitId, day, sendAt, note);
  }
  dueNudges(habitId: string, now: number) {
    return this.all<NudgeRow>("SELECT * FROM pending_nudges WHERE habit_id=? AND sent_at IS NULL AND send_at<=? ORDER BY send_at", habitId, now);
  }
  markNudgeSent(id: number, now: number) { this.run("UPDATE pending_nudges SET sent_at=? WHERE id=?", now, id); }
  sentNudgeTimes(habitId: string) {
    return this.all<{ sent_at: number }>("SELECT sent_at FROM pending_nudges WHERE habit_id=? AND sent_at IS NOT NULL", habitId).map((r) => r.sent_at);
  }
  nudges(habitId: string) { return this.all<NudgeRow>("SELECT * FROM pending_nudges WHERE habit_id=? ORDER BY id", habitId); }

  // mock integration data
  getSignal(userId: string, day: string, key: string): number | null {
    return this.get<{ value: number }>("SELECT value FROM signals WHERE user_id=? AND day=? AND key=?", userId, day, key)?.value ?? null;
  }
  setSignal(userId: string, day: string, key: string, value: number) {
    this.run("INSERT OR REPLACE INTO signals(user_id,day,key,value) VALUES(?,?,?,?)", userId, day, key, value);
  }
  addMockEvent(userId: string, day: string, title: string, startMs: number, endMs: number) {
    this.run("INSERT INTO mock_events(user_id,day,title,start_ms,end_ms) VALUES(?,?,?,?,?)", userId, day, title, startMs, endMs);
  }
  listMockEvents(userId: string, day: string) {
    return this.all<{ title: string; start_ms: number; end_ms: number }>(
      "SELECT title,start_ms,end_ms FROM mock_events WHERE user_id=? AND day=?", userId, day);
  }

  // console messenger log
  logMessage(direction: "out" | "in", handle: string, body: string, now: number) {
    this.run("INSERT INTO outbox(direction,handle,body,created_at) VALUES(?,?,?,?)", direction, handle, body, now);
  }
  // Photon Beta: where to reach each handle (learned from their inbound texts) + small key/value state
  setContact(handle: string, spaceId: string, agentId: string, now: number) {
    this.run("INSERT INTO contacts(handle,space_id,agent_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(handle) DO UPDATE SET space_id=excluded.space_id, agent_id=excluded.agent_id, updated_at=excluded.updated_at", handle, spaceId, agentId, now);
  }
  getContact(handle: string) {
    return this.get<{ handle: string; space_id: string; agent_id: string }>("SELECT handle,space_id,agent_id FROM contacts WHERE handle=?", handle);
  }
  anyAgentId() { return this.get<{ agent_id: string }>("SELECT agent_id FROM contacts ORDER BY updated_at DESC LIMIT 1")?.agent_id; }
  getKv(key: string) { return this.get<{ value: string }>("SELECT value FROM kv WHERE key=?", key)?.value; }
  setKv(key: string, value: string) { this.run("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value); }
  markSeen(id: string, now: number): boolean {
    return Number(this.run("INSERT OR IGNORE INTO seen_messages(id,seen_at) VALUES(?,?)", id, now).changes) > 0;
  }

  // connectors: one row per user and provider ("google", "ics", "health"), data is provider JSON
  setConnection(userId: string, provider: string, data: unknown, now: number) {
    this.run("INSERT INTO connections(user_id,provider,data_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at",
      userId, provider, JSON.stringify(data), now, now);
  }
  getConnection<T = any>(userId: string, provider: string): T | undefined {
    const r = this.get<{ data_json: string }>("SELECT data_json FROM connections WHERE user_id=? AND provider=?", userId, provider);
    return r ? (JSON.parse(r.data_json) as T) : undefined;
  }
  connections() { return this.all<{ user_id: string; provider: string; data_json: string }>("SELECT user_id,provider,data_json FROM connections"); }
  removeConnection(userId: string, provider: string) { this.run("DELETE FROM connections WHERE user_id=? AND provider=?", userId, provider); }
  /** Replace a user's synced events from one source inside [fromMs, toMs). */
  replaceSyncedEvents(userId: string, source: string, fromMs: number, toMs: number, events: { title: string; startMs: number; endMs: number; allDay?: boolean }[]) {
    this.run("DELETE FROM synced_events WHERE user_id=? AND source=? AND start_ms>=? AND start_ms<?", userId, source, fromMs, toMs);
    const ins = this.db.prepare("INSERT INTO synced_events(user_id,source,title,start_ms,end_ms,all_day) VALUES(?,?,?,?,?,?)");
    for (const e of events) ins.run(userId, source, e.title, e.startMs, e.endMs, e.allDay ? 1 : 0);
  }
  syncedEvents(userId: string, fromMs: number, toMs: number) {
    return this.all<{ source: string; title: string; start_ms: number; end_ms: number; all_day: number }>(
      "SELECT source,title,start_ms,end_ms,all_day FROM synced_events WHERE user_id=? AND start_ms>=? AND start_ms<? ORDER BY start_ms", userId, fromMs, toMs);
  }

  recentMessages(limit = 60) {
    return this.all<OutboxRow>("SELECT * FROM (SELECT * FROM outbox ORDER BY id DESC LIMIT ?) ORDER BY id", limit);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, tz TEXT NOT NULL, connected INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS habits(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, description TEXT NOT NULL, plan_json TEXT, status TEXT NOT NULL, start_day TEXT, duration_days INTEGER NOT NULL, escalation_json TEXT NOT NULL, invite_token TEXT NOT NULL UNIQUE, started_at INTEGER, completed_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS day_log(habit_id TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, resolved_at INTEGER NOT NULL, PRIMARY KEY(habit_id, day));
CREATE TABLE IF NOT EXISTS reminders(id INTEGER PRIMARY KEY AUTOINCREMENT, habit_id TEXT NOT NULL, day TEXT NOT NULL, due_at INTEGER NOT NULL, text TEXT NOT NULL, sent_at INTEGER, deadline_at INTEGER NOT NULL, confirmed_at INTEGER);
CREATE TABLE IF NOT EXISTS materialized(habit_id TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(habit_id, day));
CREATE TABLE IF NOT EXISTS friends(id TEXT PRIMARY KEY, habit_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, state TEXT NOT NULL, assigned_number TEXT, created_at INTEGER NOT NULL, joined_at INTEGER, UNIQUE(habit_id, phone));
CREATE TABLE IF NOT EXISTS friend_events(id INTEGER PRIMARY KEY AUTOINCREMENT, habit_id TEXT NOT NULL, friend_id TEXT NOT NULL, kind TEXT NOT NULL, day TEXT, body TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending_nudges(id INTEGER PRIMARY KEY AUTOINCREMENT, habit_id TEXT NOT NULL, day TEXT NOT NULL, send_at INTEGER NOT NULL, sent_at INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS signals(user_id TEXT NOT NULL, day TEXT NOT NULL, key TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY(user_id, day, key));
CREATE TABLE IF NOT EXISTS mock_events(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, day TEXT NOT NULL, title TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS connections(user_id TEXT NOT NULL, provider TEXT NOT NULL, data_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, provider));
CREATE TABLE IF NOT EXISTS synced_events(user_id TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS synced_events_user ON synced_events(user_id, start_ms);
CREATE TABLE IF NOT EXISTS contacts(handle TEXT PRIMARY KEY, space_id TEXT NOT NULL, agent_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seen_messages(id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT NOT NULL, handle TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
`;
