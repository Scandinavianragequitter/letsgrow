# Let'sGrow

Pick one healthy habit. An agent works out how to verify it with the least hassle, and a friend's agent has your back over iMessage if you slip. 60 days later it closes the loop with a congrats to you and a thank-you to your friend.

## Try it
```bash
npm install
cp .env.example .env        # defaults: MESSENGER=console (no real texts)
# add ANTHROPIC_API_KEY, or a free OPENROUTER_API_KEY (model: openrouter/free)
npm start                   # http://localhost:3000
```

To let friends join from their own phones, run `npm run demo` instead of `npm start` (needs `brew install cloudflared`). It opens a free Cloudflare quick tunnel to your laptop and starts the app with `PUBLIC_BASE_URL` set to the tunnel's address. Everything still runs locally; the address changes each time you run it, so start it once before a demo and leave it running.
Sign up, describe a habit ("I want to spend less time on Instagram, under an hour a day" or "I want to stretch before and after every training"), start it, copy the friend link, open it in another tab as the friend. The **Demo controls** panel lets you skip days, set Screen Time values, add calendar events, tap ❤️ as yourself and reply as the friend. The iMessage log shows every text the agents would send.

`npm run simulate` runs a full 60 days in a second and prints the timeline and final messages (`npm run simulate -- stretch gentle` for the stretching habit with the gentle policy).

## How it works
**One agent, many tools.** Every message from a person, on the website or iMessage, goes to one tool-using model call (`src/agent/agent.ts`, loop in `runtime.ts`) with the person's situation in context: habit state, plan, recent days, reminders waiting for a reply, friends, and the conversation so far (one thread across website and iMessage). The code doesn't interpret what people say; the model does, and acts through tools:

| Who | Tools |
|---|---|
| Habit builder | `list_data_sources`, `probe_data_source`, `propose_plan`, `start_habit`, `log_completion`, `set_friend_nudge_threshold`, `cancel_habit` |
| Friend | `relay_to_user` |

Tool inputs are validated with zod and each action checks it's valid in the current state (`src/engine/actions.ts`). `propose_plan` is also checked against the user's real data (e.g. a calendar-anchored reminder must match real events), and errors go back to the model to fix. So "lets go", "ja klar", a ❤️ tapback (iOS forwards it as text like `„…“ ein Herz hinzugefügt`) or "did it but only 5 min" are all just input the model reads.

**What stays deterministic, on purpose:** when reminders go out and when a day counts as done or missed (`src/engine/scheduler.ts`, `verifier.ts`), and how fast friends are told (`src/policy/escalation.ts`). Those are product rules you want to tune in code, not model judgement. Proactive texts (friend nudges, the day-60 wrap-up) are worded by the agent (`agent.write`), with fixed fallback wording in `messages.ts` so a rate limit never means a friend isn't told.

**Models.** `src/agent/llm.ts` has an Anthropic client and an OpenRouter (OpenAI-compatible) client behind one interface. Pick with `LLM_PROVIDER`, or just set one key. Free OpenRouter models work but are rate limited (about 50 requests a day, and one message can take several model calls), and tool calling quality varies by model.

**Friends** (`/join/:token`): a friend opens your link, enters their number, gets put on the shared iMessage line and texts the line once. From then on their agent texts them only when the escalation policy says so, and passes their replies on to you. On day 60 you get a wrap-up and each friend a thank-you with how often they helped.

## Adjust how fast friends are told (the part you said you're still figuring out)
Everything lives in one file: **`src/policy/escalation.ts`**.
```ts
interface EscalationPolicy {
  missedDaysBeforeNudge: number;   // 1 = first miss, 2 = two days in a row ...
  delayMinutesAfterMiss: number;   // grace period before the friend is texted
  repeatEveryMissedDays: number;   // re-nudge cadence while the streak continues (0 = once)
  maxNudgesPerWeek: number;
  minHoursBetweenNudges: number;
}
```
Presets (`immediate`, `standard`, `two_in_a_row`, `gentle`) are in the same file. The policy is stored per habit: the agent suggests one when planning, the user can change it in the UI (or `PATCH /api/habit/escalation`), and `decideNudge()` is a pure function covered by tests (`test/policy.test.ts`).

## Real iMessage (Photon)
This uses **Photon Beta (2.0)** (app.beta.photon.codes). Set in `.env`: `MESSENGER=photon`, `PHOTON_PROJECT_ID` (Settings, starts with `pho_prj_`), `PHOTON_API_KEY` (a project API key with `project:read`, `project:write` and `platforms:write`), and `SHARED_LINE_NUMBER`. No project secret is needed.

How it talks to Photon (`src/messaging/photon-beta.ts`):
- Signup and friend joins assign the person to the shared line via the API (no dashboard step).
- Inbound texts are polled from `listMessages` every 3 s (Beta webhooks can't reach localhost). A saved cursor plus a seen-message table means restarts neither miss nor repeat messages.
- Replies go out with `sendMessage` into the conversation learned from that person's first text. A shared line can't text first, so everyone texts the line once ("hi" / "ping").
- Beta has no tapback events, but iOS forwards a tapback as text (`Loved “…”`, `„…“ ein Herz hinzugefügt`); those are turned back into reactions, so "react ❤️" still works. Replying "done" also counts.

`PUBLIC_BASE_URL` must be reachable from your friend's phone (ngrok / cloudflared); `localhost` only works on your own machine.

Shared-line rules that shape the product: direct chats only, and the agent can only text someone who is assigned **and has texted the line first**. That's why signup asks you to text "hi" and the join page asks friends to text "ping". Reminders wait until you've connected.

## Swapping the mock data for real data
`src/integrations/mock.ts` implements `Integrations` (`metric()` and `events()`). It serves seeded data (`MOCK_AUTOFILL=1`) overridden by whatever you set in the demo panel. Replace it with real sources:
- **Screen Time**: Apple offers no server API. You need an iOS app using FamilyControls/DeviceActivity that uploads daily totals.
- **Health**: HealthKit (also on-device) or a cloud aggregator.
- **Calendar**: Google Calendar / Microsoft Graph / CalDAV.

## Layout
```
src/agent/        agent + tools, agent loop, plan schema, Anthropic/OpenRouter clients
src/engine/       habit actions, scheduler, verifier, fallback copy, stats
src/policy/       escalation policy and presets
src/integrations/ mock Screen Time / Health / Calendar
src/messaging/    console + Photon Beta messengers, shared-line assigner
src/web/          Hono server + static UI
test/             node:test (policy, clock, scheduler incl. a full 60-day run, agent tools with a scripted model, OpenRouter format, HTTP flow)
```

## Known limits
- Never run against live Photon or Anthropic from the build environment; the Photon code follows their docs and SDK types and is typechecked, not exercised.
- Signup identifies you by phone number with no verification (fine for a demo, not for production).
- One person can't be both owner and friend of the same habit (a number is either the habit builder or a friend).
- Needs Node >= 22.13 (uses the built-in `node:sqlite`).
