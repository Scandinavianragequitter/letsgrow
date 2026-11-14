# Let'sGrow

Pick one healthy habit. An agent works out how to verify it with the least hassle, and a friend's agent has your back over iMessage if you slip. 60 days later it closes the loop with a congrats to you and a thank-you to your friend.

## Try it in 2 minutes (no keys needed)
```bash
npm install
cp .env.example .env        # defaults: MESSENGER=console
# set LLM_MOCK=1 in .env to use a keyword-based stand-in planner, or add ANTHROPIC_API_KEY for the real agent
npm start                   # http://localhost:3000
```
Sign up, describe a habit ("I want to spend less time on Instagram, under an hour a day" or "I want to stretch before and after every training"), start it, copy the friend link, open it in another tab as the friend. The **Demo controls** panel lets you skip days, set Screen Time values, add calendar events, tap ❤️ as yourself and reply as the friend. The iMessage log shows every text the agents would send.

`npm run simulate` runs a full 60 days in a second and prints the timeline and final messages (`npm run simulate -- stretch gentle` for the stretching habit with the gentle policy).

## How it works
1. **Chat** (`src/agent/`): Claude gets the list of available data sources and one tool, `propose_plan`. The plan (validated by zod in `plan.ts`) is either
   - **autonomous**: a metric + threshold from Screen Time/Health, checked at a set time (e.g. `app_minutes:Instagram <= 60`). Zero effort for you, or
   - **prompted**: reminders anchored to calendar events (e.g. 10 min before and 5 min after any "training"), confirmed with one ❤️ tapback.
2. **Daily loop** (`src/engine/scheduler.ts`): materialises each day's reminders, sends them, resolves each day as done / missed / not applicable / unknown (no data never counts as a miss).
3. **Friends** (`/join/:token`): friend opens your link, enters their number, gets put on the shared iMessage line, texts "ping" once, and then their agent texts them only when you slip. Their replies are relayed to you.
4. **Day 60**: you get a summary, each friend gets a thank-you with how often they were asked to help and how often they replied.

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
Presets (`immediate`, `standard`, `two_in_a_row`, `gentle`) are in the same file. The policy is stored per habit: the planner suggests one, the user can change it in the UI (or `PATCH /api/habit/escalation`), and `decideNudge()` is a pure function covered by tests (`test/policy.test.ts`).

## Real iMessage (Photon)
Set in `.env`: `MESSENGER=photon`, `PROJECT_ID`, `PROJECT_SECRET` (Spectrum), `SHARED_LINE_NUMBER`, and `PHOTON_API_KEY` (a project API key with `platforms:write`, used to assign users and friends to the shared line). `PUBLIC_BASE_URL` must be reachable from your friend's phone (ngrok / cloudflared); `localhost` only works on your own machine.

Shared-line rules that shape the product: direct chats only, and the agent can only text someone who is assigned **and has texted the line first**. That's why signup asks you to text "hi" and the join page asks friends to text "ping". Reminders wait until you've connected.

## Swapping the mock data for real data
`src/integrations/mock.ts` implements `Integrations` (`metric()` and `events()`). It serves seeded data (`MOCK_AUTOFILL=1`) overridden by whatever you set in the demo panel. Replace it with real sources:
- **Screen Time**: Apple offers no server API. You need an iOS app using FamilyControls/DeviceActivity that uploads daily totals.
- **Health**: HealthKit (also on-device) or a cloud aggregator.
- **Calendar**: Google Calendar / Microsoft Graph / CalDAV.

## Layout
```
src/agent/        planner (Claude tool-use), plan schema, LLM clients
src/engine/       scheduler, verifier, inbound routing, copy, stats
src/policy/       escalation policy and presets
src/integrations/ mock Screen Time / Health / Calendar
src/messaging/    console + Photon messengers, shared-line assigner
src/web/          Hono server + static UI
test/             node:test (policy, clock, scheduler incl. a full 60-day run, planner, HTTP flow)
```

## Known limits
- Never run against live Photon or Anthropic from the build environment; the Photon code follows their docs and SDK types and is typechecked, not exercised.
- Signup identifies you by phone number with no verification (fine for a demo, not for production).
- One person can't be both owner and friend of the same habit (the first text from a number is interpreted as the friend's "ping").
- Needs Node >= 22.13 (uses the built-in `node:sqlite`).
