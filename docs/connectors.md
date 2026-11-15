# Connecting real data

Let'sGrow uses real data for a person as soon as they connect a source, and demo data until then.
The agent sees which is which, and sends a personal link when a source would help.

| Source | How a person connects | One-time setup by you |
|---|---|---|
| Apple Calendar | Turns on *Public Calendar* for one calendar and shares the link into the chat (or pastes it on the link page) | none |
| Google Calendar | Taps the link, picks their account, taps *Allow* | Google Cloud OAuth client (below) |
| Gmail | Same as Google Calendar | same client |
| Apple Health | Adds the Shortcut and turns on a daily automation (about a minute, once) | build the Shortcut once (below) |

Screen Time stays demo data: Apple offers no way to read it from a server.

## Google Calendar and Gmail

1. Go to https://console.cloud.google.com, create a project (e.g. "Let'sGrow").
2. *APIs & Services → Library*: enable **Google Calendar API** and **Gmail API**.
3. *OAuth consent screen*: User type **External**, app name "Let'sGrow", your email. Leave it in **Testing** and add every Google account that will connect (yours, your demo friends) as a **test user**. Scopes: `calendar.readonly`, `gmail.readonly`.
4. *Credentials → Create credentials → OAuth client ID*, type **Web application**. Authorized redirect URI: `http://localhost:3000/oauth/google/callback`
5. Put the client ID and secret in `.env`:
   ```
   GOOGLE_CLIENT_ID=…apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=…
   ```

Things to know:
- **Open Google links on the laptop.** The redirect goes back to `localhost`, so the link only finishes on the machine running Let'sGrow. With a fixed public address (your own domain), register `https://<domain>/oauth/google/callback` and set `GOOGLE_REDIRECT_URI` to it; then links work from any phone.
- **Testing mode** shows an "unverified app" screen (tap *Continue*) and only works for the test users you added. Gmail read access is a *restricted* scope: to open it to everyone, Google requires an app review and a security assessment.
- Gmail is read for metadata only (sender, subject, date, a short snippet) and only for searches the agent makes to check a habit.

## Apple Health

There is no server API, so the iPhone sends a few numbers once a day. Each person gets a private upload address on their link page.

**Build the Shortcut once** (Shortcuts app on your iPhone), name it **Let'sGrow Health**:

1. *Find Health Samples* where **Type is Steps** and **Start Date is today** → *Calculate Statistics*: **Sum** → *Set Variable* `Steps`.
2. *Find Health Samples* where **Type is Exercise Minutes** (Apple Exercise Time) and **Start Date is today** → *Calculate Statistics*: **Sum** → *Set Variable* `Exercise`.
3. Optional, per workout type: *Find Workouts* where **Type is Rowing** and **Start Date is today** → *Get Details of Workouts*: **Duration** → *Calculate Statistics*: **Sum** → *Set Variable* `Rowing` (minutes).
4. *Get Contents of URL*: URL = a *Text* action holding the upload address; **Method POST**, **Request Body JSON** with
   - `steps` (Number) = `Steps`
   - `workout_minutes` (Number) = `Exercise`
   - `workouts` (Array) → one Dictionary: `type` = `Rowing`, `minutes` = `Rowing`
5. In the Shortcut's settings → **Setup** → *Import Questions*, add a question for the URL text ("Paste your Let'sGrow address"). Then *Share → Copy iCloud Link* and put it in `.env`:
   ```
   HEALTH_SHORTCUT_URL=https://www.icloud.com/shortcuts/…
   ```
   Everyone else now gets an **Add Shortcut** button on their link page and only pastes their own address.

**Each person then**: *Shortcuts → Automation → New → Time of Day*, 21:30, Daily, **Run Immediately**, action: run *Let'sGrow Health*. Apple doesn't let automations be shared, so this step is theirs (about 5 taps).

Any other format works too: the address accepts `{ "date": "YYYY-MM-DD", "steps", "workout_minutes", "workouts": [{ "type", "minutes" }], "sleep_hours", "mindful_minutes" }` (all optional) and the JSON that the **Health Auto Export** app sends from its REST API automation.

Try it without a phone:
```bash
curl -X POST <upload address> -H 'content-type: application/json' \
  -d '{"steps":8123,"workouts":[{"type":"Rowing","minutes":30}]}'
```

## Apple Calendar

No setup. In the iPhone Calendar app: *Calendars → ⓘ next to the calendar → Public Calendar → Share Link…* and send it to the Let'sGrow chat. The agent recognises the link, connects it and confirms the events it sees. Anyone with a public link can view that calendar, so share one that only holds what the agent needs (e.g. "Training"). Calendars refresh every `SYNC_MINUTES` (default 10).
