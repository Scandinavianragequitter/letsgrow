import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { Clock } from "./clock.js";
import { Store } from "./db.js";
import { MockIntegrations } from "./integrations/mock.js";
import { createLlm } from "./agent/llm.js";
import { LetsGrowAgent } from "./agent/agent.js";
import { HabitActions } from "./engine/actions.js";
import { Scheduler } from "./engine/scheduler.js";
import { ConsoleMessenger, type Messenger } from "./messaging/messenger.js";
import { PhotonBetaMessenger, photonClient } from "./messaging/photon-beta.js";
import { ConsoleAssigner, PhotonAssigner, type LineAssigner } from "./messaging/assigner.js";
import { createApp } from "./web/server.js";
import { ConnectorHub } from "./integrations/hub.js";
import { ConnectLinks } from "./engine/connect.js";
import { LoginCodes } from "./engine/login.js";

const store = new Store(config.dbPath);
const clock = new Clock(config.timeScale);
const now = () => clock.now();
const mock = new MockIntegrations(store, config.mockAutofill);
// Real data where a person connected a source (calendar link, Google, Apple Health), demo data otherwise.
const integrations = new ConnectorHub({ store, mock, google: config.google, now: () => Date.now(), demoData: config.mockAutofill });
const links = new ConnectLinks({ store, publicBaseUrl: config.publicBaseUrl, googleRedirectUri: config.google?.redirectUri, now: () => Date.now() });
const llm = createLlm(config.llm);

let transport: Messenger;
let assigner: LineAssigner;
if (config.messenger === "photon") {
  if (!config.projectId || !config.photonApiKey) {
    console.error("MESSENGER=photon needs PHOTON_PROJECT_ID (pho_prj_...) and PHOTON_API_KEY in .env");
    process.exit(1);
  }
  transport = new PhotonBetaMessenger({ client: photonClient(config.photonApiKey), projectId: config.projectId, store, now });
  assigner = new PhotonAssigner(config.photonApiKey, config.projectId, config.sharedLineNumber);
} else {
  transport = new ConsoleMessenger(store, now);
  assigner = new ConsoleAssigner(config.sharedLineNumber);
}

const actions = new HabitActions({ store, durationDays: config.durationDays, publicBaseUrl: config.publicBaseUrl, now });
const agent = new LetsGrowAgent({ store, llm, integrations, actions, messenger: transport, now, hub: integrations, links });
const messenger = agent.messenger; // records every text in the person's thread
const scheduler = new Scheduler({ store, integrations, messenger, publicBaseUrl: config.publicBaseUrl, write: (r) => agent.write(r), matchEvents: agent.matchEvents });
// Live site (real iMessage): signing in on the website = texting your code to the agent.
const login = config.messenger === "photon" ? new LoginCodes({ store, now: () => Date.now() }) : undefined;
await messenger.start((e) => {
  const signedIn = !!login && e.kind === "text" && login.verifyFromText(e.handle, e.text ?? "");
  return agent.onInbound(e, signedIn ? ["They just signed in on the website by texting this code. Welcome them in one or two sentences; if they have no habit yet, ask what they want to build."] : []);
});

const devPanel = config.messenger === "console" || process.env.DEV_PANEL === "1";
const consoleTransport = transport instanceof ConsoleMessenger ? transport : undefined;
const connect = {
  store, hub: integrations, links, google: config.google, now: () => Date.now(),
  // Close the loop on iMessage when someone connects a source from a link.
  onConnected: async (userId: string, what: string) => {
    const user = store.getUser(userId);
    if (!user || (messenger.mode === "photon" && !user.connected)) return;
    // The coach takes a real turn: it can look at the new data right away and continue where you left off.
    try {
      await agent.onEvent(user, `They just connected ${what}. Look at it now with your tools and continue the conversation from there: say in a sentence what you found that matters for their habit, then take the next step (e.g. propose or adjust the plan). Don't just confirm the connection.`);
    } catch (err) { console.warn("follow-up after connect failed:", (err as Error).message); }
  },
};
const app = createApp({ store, clock, agent, actions, scheduler, messenger, assigner, devPanel, consoleTransport, connect, login });
void integrations.syncAll();
setInterval(() => { void integrations.syncAll(); }, config.syncMinutes * 60_000);

setInterval(() => { void scheduler.tick(clock.now()); }, config.tickMs);
serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Let'sGrow running at ${config.publicBaseUrl}  (messenger: ${messenger.mode}, model: ${llm.label}, dev panel: ${devPanel ? "on" : "off"})`);
  if (llm.label === "none") console.warn("No LLM configured: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in .env.");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => { await messenger.stop(); process.exit(0); });
}
