import { z } from "zod";
import type { Store, UserRow, FriendRow, HabitRow } from "../db.js";
import type { Integrations, SourceId } from "../integrations/mock.js";
import type { InboundEvent, InboundHandler, Messenger } from "../messaging/messenger.js";
import type { LlmClient } from "./llm.js";
import { runAgent, type Tool } from "./runtime.js";
import { HabitPlanSchema, type HabitPlan } from "./plan.js";
import { HabitActions } from "../engine/actions.js";
import { dayKey, addDays, zonedTime } from "../clock.js";
import { computeStats, friendHelp } from "../engine/stats.js";
import type { EscalationPolicy } from "../policy/escalation.js";
import type { ConnectorHub } from "../integrations/hub.js";
import type { ConnectLinks } from "../engine/connect.js";
import { GmailVerifier } from "./gmail-verifier.js";

// The Let'sGrow agent. Every message from a person (website chat or iMessage) goes through one
// tool-using model call with the full situation in context. The code does not try to interpret
// what people mean; it gives the model accurate state, a few well-defined actions, and checks
// that each action is valid. Scheduling, verification and the friend-escalation policy stay
// deterministic (see engine/scheduler.ts and policy/escalation.ts).

export type Party =
  | { kind: "user"; user: UserRow }
  | { kind: "friend"; friend: FriendRow; habit: HabitRow; owner: UserRow }
  | { kind: "unknown"; handle: string };

export interface AgentDeps {
  store: Store;
  llm: LlmClient;
  integrations: Integrations;
  actions: HabitActions;
  /** Raw transport. The agent wraps it so every message lands in the person's thread. */
  messenger: Messenger;
  now: () => number;
  /** Real connectors (calendar links, Google, Apple Health). Without them the agent works on demo data. */
  hub?: ConnectorHub;
  links?: ConnectLinks;
}

export class LetsGrowAgent {
  /** Use this messenger everywhere (scheduler too) so proactive texts are part of the thread. */
  readonly messenger: Messenger;
  private gmailVerifier?: GmailVerifier;

  constructor(private d: AgentDeps) {
    if (d.hub) this.gmailVerifier = new GmailVerifier({ llm: d.llm, hub: d.hub });
    const self = this;
    const raw = d.messenger;
    this.messenger = {
      get mode() { return raw.mode; },
      async send(handle, body) {
        await raw.send(handle, body);
        const p = self.resolve(handle);
        if (p.kind !== "unknown") d.store.addChat(partyId(p), "assistant", body, d.now(), "imessage");
      },
      start: (h: InboundHandler) => raw.start(h),
      stop: () => raw.stop(),
    };
  }

  // ---------- entry points ----------

  /** A text (or tapback, or attachment) arrived on iMessage. */
  async onInbound(e: InboundEvent): Promise<void> {
    const { store, now } = this.d;
    const party = this.resolve(e.handle);
    const text = e.kind === "text" ? (e.text ?? "") : e.kind === "reaction" ? `[tapback ${e.emoji}]` : "[sent an attachment]";
    const events: string[] = [];

    // Facts, not interpretation: the first text from a person is what connects them.
    if (party.kind === "user" && !party.user.connected) {
      store.markUserConnected(party.user.id);
      events.push("This is their first text on iMessage, so they are now connected and you can text them from here on.");
    }
    if (party.kind === "friend" && party.friend.state === "assigned") {
      store.activateFriend(party.friend.id, now());
      store.addFriendEvent(party.habit.id, party.friend.id, "joined", null, null, now());
      events.push(`${party.friend.name} just joined as ${party.owner.name}'s accountability friend with this text. Welcome them and explain briefly what you'll do.`);
    }

    const reply = await this.respond(this.resolve(e.handle), text, "imessage", events);
    if (reply) await this.messenger.send(replyTarget(party, e.handle), reply);
  }

  /** The website chat. Same agent, same thread as iMessage. */
  async chat(user: UserRow, text: string): Promise<string> {
    const reply = await this.respond({ kind: "user", user }, text, "web", []);
    this.d.store.addChat(user.id, "assistant", reply, this.d.now(), "web");
    return reply;
  }

  /**
   * Write a proactive message (nudge, wrap-up, ...) in the agent's voice. Falls back to the given
   * text if the model is unavailable, so a rate limit never means a friend isn't told.
   */
  async write(req: { to: string; purpose: string; facts: Record<string, unknown>; fallback: string }): Promise<string> {
    try {
      const out = await this.d.llm.complete({
        system: `${VOICE}\nWrite exactly one iMessage to ${req.to}. Purpose: ${req.purpose}\nUse only these facts:\n${JSON.stringify(req.facts, null, 2)}\nOutput only the message text.`,
        messages: [{ role: "user", content: "Write the message." }],
        maxTokens: 400,
      });
      const text = out.text.trim().replace(/^"|"$/g, "");
      return text.length >= 2 && text.length <= 700 ? text : req.fallback;
    } catch (err) {
      console.warn("agent write failed, using fallback:", (err as Error).message);
      return req.fallback;
    }
  }

  // ---------- core ----------

  private async respond(party: Party, text: string, channel: "web" | "imessage", events: string[]): Promise<string> {
    const { store, llm, now } = this.d;
    const transcript = party.kind === "unknown" ? "" : this.transcript(partyId(party));
    if (party.kind !== "unknown") store.addChat(partyId(party), "user", text, now(), channel);

    const { system, tools } =
      party.kind === "user" ? this.userTurn(party.user, channel)
      : party.kind === "friend" ? this.friendTurn(party)
      : { system: `${VOICE}\nSomeone texted the Let'sGrow line from ${party.handle}, but they have not signed up and nobody invited them. Tell them briefly that Let'sGrow helps people build a habit with a friend's support, and that they can sign up on the website or ask a friend for an invite link.`, tools: [] as Tool[] };

    const full = [
      system,
      events.length ? `\n## Just happened\n${events.map((e) => `- ${e}`).join("\n")}` : "",
      transcript ? `\n## Conversation so far (oldest first)\n${transcript}` : "",
    ].join("\n");

    try {
      const run = await runAgent({ llm, system: full, input: text, tools });
      if (run.calls.length) console.log(`[agent] ${run.calls.map((c) => `${c.name}${c.ok ? "" : " (failed)"}`).join(", ")}`);
      return run.text;
    } catch (err) {
      console.error("agent failed:", (err as Error).message);
      return "Sorry, I'm having trouble thinking right now. Try again in a minute.";
    }
  }

  private resolve(handle: string): Party {
    const { store } = this.d;
    const user = store.getUserByPhone(handle);
    if (user) return { kind: "user", user };
    for (const friend of store.friendsByPhone(handle)) {
      const habit = store.getHabit(friend.habit_id);
      if (habit && (habit.status === "active" || habit.status === "completed")) {
        return { kind: "friend", friend, habit, owner: store.getUser(habit.user_id)! };
      }
    }
    return { kind: "unknown", handle };
  }

  private transcript(id: string): string {
    const { store } = this.d;
    return store.chat(id, 30).map((m) =>
      `[${this.fmt(m.created_at)}, ${m.channel === "imessage" ? "iMessage" : "website"}] ${m.role === "user" ? "Them" : "Let'sGrow"}: ${m.content}`,
    ).join("\n");
  }

  private fmt(ms: number, tz = "America/New_York") {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
  }

  // ---------- the habit builder ----------

  private userTurn(user: UserRow, channel: "web" | "imessage"): { system: string; tools: Tool[] } {
    const { store, integrations, actions, now } = this.d;
    const fresh = () => store.getUser(user.id)!;
    const today = dayKey(now(), user.tz);

    const tools: Tool[] = [
      {
        name: "list_data_sources",
        description: "What data this user has connected (screen time, health, calendar) and what each can measure.",
        input: z.object({}),
        run: () => integrations.catalog(user.id),
      },
      {
        name: "probe_data_source",
        description: "Look at this user's real data before planning. screen_time/health: without metric, daily averages for every metric over the last 7 days; with metric, the last 7 daily values. calendar: events in the next 14 days, optionally filtered by a keyword in the title.",
        input: z.object({
          source: z.enum(["screen_time", "health", "calendar"]),
          metric: z.string().optional().describe("e.g. app_minutes:Instagram, steps"),
          keyword: z.string().optional().describe("calendar only: substring of event titles, e.g. training"),
        }),
        run: (i: { source: SourceId; metric?: string; keyword?: string }) => integrations.probe(user.id, user.tz, today, i),
      },
      {
        name: "propose_plan",
        description: "Save how this habit will be verified (replaces any earlier proposal). Only possible while no habit is running. The plan is checked against the user's real data; fix it if an error comes back.",
        input: z.object({ plan: HabitPlanSchema, habit_in_their_words: z.string().min(2).max(200) }),
        run: (i: { plan: HabitPlan; habit_in_their_words: string }) => {
          const problem = this.groundingProblem(user, today, i.plan);
          if (problem) return { error: problem };
          const h = actions.savePlan(fresh(), i.plan, i.habit_in_their_words);
          return { saved: true, title: i.plan.title, status: h.status, friendNudgeAfterMissedDays: i.plan.suggestedMissedDaysBeforeFriendNudge, next: "Explain it in 1-3 sentences and ask if they want to start." };
        },
      },
      {
        name: "start_habit",
        description: "Start the proposed plan today, once the user has agreed. Returns the invite message they should forward to a friend.",
        input: z.object({}),
        run: () => {
          const r = actions.start(fresh());
          return { started: r.plan.title, days: r.habit.duration_days, startDay: r.habit.start_day, inviteMessageToForward: r.inviteMessage, connectedOnIMessage: !!fresh().connected };
        },
      },
      {
        name: "log_completion",
        description: "Record that the user did the habit for a reminder you sent (by id, or the oldest one waiting if omitted). Use whenever they indicate they did it, in any words, emoji or tapback.",
        input: z.object({ reminder_id: z.number().int().optional() }),
        run: (i: { reminder_id?: number }) => actions.logCompletion(fresh(), i.reminder_id),
      },
      {
        name: "set_friend_nudge_threshold",
        description: "Change after how many consecutive missed days their friends are asked to step in (1 = right away).",
        input: z.object({ missed_days: z.number().int().min(1).max(5) }),
        run: (i: { missed_days: number }) => ({ policy: actions.setFriendThreshold(fresh(), i.missed_days) }),
      },
      ...this.connectorTools(user),
      {
        name: "cancel_habit",
        description: "Stop the current habit or proposal so a new one can be planned. Only after the user clearly asked for it.",
        input: z.object({}),
        run: () => actions.cancel(fresh()),
      },
    ];

    const system = `${VOICE}
You are talking with ${user.name}, who is building a habit with Let'sGrow, on ${channel === "imessage" ? "iMessage (keep it to a few short sentences, no markdown)" : "the Let'sGrow website chat"}.
Local time for them: ${this.fmt(now(), user.tz)} (${user.tz}).

## What Let'sGrow does
${user.name} picks one healthy habit. You work out how to verify it with the least effort for them, run it for the habit's duration, and if they slip, their friend's agent asks the friend for a word of support. How quickly friends are asked is a policy you can adjust.

## How to plan a habit
1. Find out what data actually exists: list_data_sources, then probe_data_source for the relevant source(s). Do not assume.
2. If a connected source can measure the habit directly, verify it autonomously: no effort for them at all. Prefer this.
3. Otherwise plan prompted check-ins with the least burden: anchor reminders to their real calendar events when there are any (check with probe_data_source calendar + keyword), otherwise a fixed time. Confirmation should be one tap: reacting to the reminder (iPhone tapback, e.g. ❤️) or a one-word reply.
4. Pick a sensible threshold/timing yourself. Ask at most one short question, and only if you truly cannot choose.
5. propose_plan, then tell them in 1-3 short sentences how you'll verify it and what they have to do, and ask if they want to start. When they agree in any words, call start_habit and give them the invite message to forward to a friend.

## While a habit is running
- When they say or show they did it (any wording, emoji, or tapback on your reminder), call log_completion. iPhones forward tapbacks as text such as: Loved “…”, Reacted ❤️ to “…”, or in German „…“ ein Herz hinzugefügt. Treat those as a reaction to the quoted message. The phone writes that text in its own language, so it says nothing about which language to reply in: keep the language of the conversation.
- If they want friends told sooner or later, use set_friend_nudge_threshold.
- Answer questions about progress from the state below. Never claim you did something unless a tool call succeeded.

## Connecting real data
The data sources say whether they are connected (real data) or not (demo data). When a habit would be checked better with a source that isn't connected, say so in a sentence and send the personal link from request_connection. Google Calendar and Gmail are one tap (Google's Allow screen); Apple Health is a one-time Shortcut setup on the iPhone; for an Apple calendar, ask them to share a public calendar link in this chat. When they send a webcal:// or .ics link, call connect_calendar_link with it. Gmail is only for checks that leave a trace by email (e.g. an app's streak email, a booking confirmation). You never read email yourself: check_email asks a separate, quarantined checker and returns only found / not found / unclear.

## Web search
If web search is available, use it when current outside facts would make the plan or answer better (a gym's opening hours, a class schedule, a sensible target for a sport). Don't search for things you know or for anything about the user; mention the source briefly when you rely on it.

## Current state
${JSON.stringify(this.userState(user), null, 2)}`;
    return { system, tools };
  }

  private connectorTools(user: UserRow): Tool[] {
    const { hub, links } = this.d;
    if (!hub || !links) return [];
    return [
      {
        name: "request_connection",
        description: "Get a personal link that connects one data source in a tap or two. Send the link in your reply with one short sentence on what it's for.",
        input: z.object({ connector: z.enum(["google_calendar", "gmail", "apple_health", "apple_calendar"]) }),
        run: (i: { connector: "google_calendar" | "gmail" | "apple_health" | "apple_calendar" }) => {
          if ((i.connector === "google_calendar" || i.connector === "gmail") && !hub.status(user.id).google_configured) {
            return { error: "Google sign-in isn't configured on this server. Offer an Apple calendar link instead, or skip." };
          }
          return links.link(user.id, i.connector);
        },
      },
      {
        name: "connect_calendar_link",
        description: "Connect a published calendar from a link the user sent (webcal:// or https://…ics, e.g. an Apple Public Calendar). Returns upcoming events so you can confirm.",
        input: z.object({ url: z.string().min(8) }),
        run: async (i: { url: string }) => hub.connectCalendarLink(user.id, i.url),
      },
      {
        name: "check_email",
        description: "Ask the quarantined email checker a yes/no question about the user's Gmail, e.g. \"Did they get a Duolingo streak email today?\". You get back only status (found/not_found/unclear), count and confidence, never email text. Use it to check a habit or to test whether an email-based check would work while planning.",
        input: z.object({
          question: z.string().min(5).max(300),
          gmail_query_hint: z.string().max(200).optional().describe("e.g. from:duolingo"),
          days: z.number().int().min(1).max(30).default(1),
        }),
        run: async (i: { question: string; gmail_query_hint?: string; days: number }) => {
          if (!this.gmailVerifier) return { error: "Email checking isn't available." };
          return this.gmailVerifier.verify(user.id, { question: i.question, queryHint: i.gmail_query_hint, days: i.days });
        },
      },
    ];
  }

  /** Check a proposed plan against the user's actual data (grounding, not interpretation). */
  private groundingProblem(user: UserRow, today: string, plan: HabitPlan): string | undefined {
    const { integrations } = this.d;
    if (plan.mode === "autonomous" && plan.autonomous) {
      const a = plan.autonomous;
      if (a.source === "email") {
        if (!this.d.hub?.status(user.id).gmail) return "Gmail isn't connected. Send them the link from request_connection gmail first, or plan a different check.";
        return undefined; // counted live by the sync loop; probe_data_source email shows what matches
      }
      if (a.source === "calendar") return "The calendar can time reminders but cannot measure a habit. Use screen_time or health, or a prompted plan.";
      const values = Array.from({ length: 7 }, (_, i) => integrations.metric(user.id, a.source, a.metric, addDays(today, i - 7)));
      if (values.every((v) => v === null)) return `No ${a.source} data for metric "${a.metric}" in the last 7 days. Probe the source to see which metrics exist.`;
    }
    for (const r of plan.prompted?.reminders ?? []) {
      if (r.anchor !== "calendar_event" || !r.eventKeyword) continue;
      const kw = r.eventKeyword.toLowerCase();
      const hits = Array.from({ length: 14 }, (_, i) => addDays(today, i))
        .flatMap((d) => integrations.events(user.id, d, user.tz))
        .filter((e) => e.title.toLowerCase().includes(kw));
      if (hits.length === 0) return `No calendar events containing "${r.eventKeyword}" in the next 14 days. Probe the calendar, pick a keyword that matches, or use a fixed_time reminder.`;
    }
    return undefined;
  }

  private userState(user: UserRow) {
    const { store, actions, now } = this.d;
    const habit = store.currentHabit(user.id);
    const base = { connectedOnIMessage: !!user.connected, connectors: this.d.hub ? this.d.hub.status(user.id) : "demo data only" };
    if (!habit) return { ...base, habit: null };
    const plan = habit.plan_json ? (JSON.parse(habit.plan_json) as HabitPlan) : null;
    const policy = JSON.parse(habit.escalation_json) as EscalationPolicy;
    const today = dayKey(now(), user.tz);
    const help = friendHelp(store, habit.id);
    return {
      ...base,
      habit: {
        status: habit.status,
        inTheirWords: habit.description,
        plan,
        startDay: habit.start_day,
        dayNumber: habit.start_day ? Math.min(habit.duration_days, Math.max(1, Math.round((zonedTime(today, "12:00", user.tz) - zonedTime(habit.start_day, "12:00", user.tz)) / 86_400_000) + 1)) : null,
        durationDays: habit.duration_days,
        stats: habit.start_day ? computeStats(store, habit) : null,
        recentDays: store.days(habit.id).slice(-7).map((d) => ({ day: d.day, status: d.status, detail: d.detail })),
        todaysReminders: store.remindersForDay(habit.id, today).map((r) => ({
          id: r.id, text: r.text, due: this.fmt(r.due_at, user.tz), sent: r.sent_at !== null, confirmed: r.confirmed_at !== null,
        })),
        remindersWaitingForConfirmation: store.pendingReminders(habit.id).map((r) => ({
          id: r.id, day: r.day, text: r.text, sentAt: r.sent_at && this.fmt(r.sent_at, user.tz), confirmBy: this.fmt(r.deadline_at, user.tz),
        })),
        friendsAreAskedAfterConsecutiveMisses: policy.missedDaysBeforeNudge,
        friends: store.friends(habit.id).map((f) => ({ name: f.name, joined: f.state === "active", ...help.get(f.id) })),
        inviteMessage: habit.status === "active" ? actions.inviteMessage(habit) : null,
      },
    };
  }

  // ---------- the friend ----------

  private friendTurn(p: Extract<Party, { kind: "friend" }>): { system: string; tools: Tool[] } {
    const { store, now } = this.d;
    const { friend, habit, owner } = p;
    const plan = JSON.parse(habit.plan_json!) as HabitPlan;
    const tools: Tool[] = [
      {
        name: "relay_to_user",
        description: `Pass a message from ${friend.name} on to ${owner.name}. Use it when ${friend.name} sends support or anything meant for ${owner.name}. Keep their words; you may add "${friend.name} says:".`,
        input: z.object({ message: z.string().min(1).max(600) }),
        run: async (i: { message: string }) => {
          store.addFriendEvent(habit.id, friend.id, "support_reply", null, i.message, now());
          await this.messenger.send(owner.phone, i.message);
          return { delivered: true };
        },
      },
    ];
    // The habit is private until the friend is needed: before the first nudge the agent isn't told
    // what it is, so it can't let it slip however the friend asks.
    const revealed = habitRevealedTo(store, habit, friend);
    const habitLine = revealed
      ? `for "${plan.title}"`
      : `for a habit ${owner.name} is keeping private unless they slip. You don't know which habit it is; if asked, say ${friend.name} will find out only if ${owner.name} needs a nudge`;
    const help = friendHelp(store, habit.id).get(friend.id) ?? { nudges: 0, replies: 0 };
    const system = `${VOICE}
You are ${owner.name}'s Let'sGrow agent, texting with ${friend.name} on iMessage. ${owner.name} asked ${friend.name} to be their accountability friend ${habitLine} (${habit.duration_days} days). You only text ${friend.name} when ${owner.name} slips, to ask for a short word of support, which you pass on. Keep it to a few short sentences.
Local time: ${this.fmt(now(), owner.tz)}.

## State
${JSON.stringify({
  habitStatus: habit.status,
  stats: computeStats(store, habit),
  recentDays: store.days(habit.id).slice(-7).map((d) => ({ day: d.day, status: d.status })),
  timesYouAskedThisFriendForSupport: help.nudges,
  timesTheyReplied: help.replies,
}, null, 2)}`;
    return { system, tools };
  }
}

const VOICE = `You are Let'sGrow, a warm, brief accountability agent that helps people build one healthy habit with a friend's support. Write like a thoughtful friend texting: plain sentences, no markdown, no bullet lists, no lecturing. Reply in the language the person writes in.`;

/** A friend learns the habit once they've been asked to step in. */
export function habitRevealedTo(store: Store, habit: HabitRow, friend: FriendRow): boolean {
  return (friendHelp(store, habit.id).get(friend.id)?.nudges ?? 0) > 0;
}

/**
 * Where an agent's reply may go. Fixed by code, not by the model: the coach answers only the user,
 * a friend's agent only that friend. The only cross-person path is relay_to_user (friend to user).
 */
export function replyTarget(p: Party, handle: string): string {
  if (p.kind === "user") return p.user.phone;
  if (p.kind === "friend") return p.friend.phone;
  return handle;
}

function partyId(p: Exclude<Party, { kind: "unknown" }>) {
  return p.kind === "user" ? p.user.id : p.friend.id;
}
