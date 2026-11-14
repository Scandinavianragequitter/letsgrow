# page

A small Spectrum (Photon) iMessage agent.

- Replies to every text it receives (swap the echo in `src/agent.ts` for your agent logic).
- Sends a periodic heartbeat text to everyone who has messaged it.

## Setup
```bash
npm install
cp .env.example .env   # PROJECT_ID and PROJECT_SECRET from the Photon dashboard
npm start
```

## Notes
- On a shared iMessage line the agent can only text people who have an active
  assignment and have messaged the line first, so the heartbeat only reaches those people.
- Never commit `.env`.
