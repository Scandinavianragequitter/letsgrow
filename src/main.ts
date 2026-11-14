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

const store = new Store(config.dbPath);
const clock = new Clock(config.timeScale);
const now = () => clock.now();
const integrations = new MockIntegrations(store, config.mockAutofill);
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
const agent = new LetsGrowAgent({ store, llm, integrations, actions, messenger: transport, now });
const messenger = agent.messenger; // records every text in the person's thread
const scheduler = new Scheduler({ store, integrations, messenger, publicBaseUrl: config.publicBaseUrl, write: (r) => agent.write(r) });
await messenger.start((e) => agent.onInbound(e));

const devPanel = config.messenger === "console" || process.env.DEV_PANEL === "1";
const consoleTransport = transport instanceof ConsoleMessenger ? transport : undefined;
const app = createApp({ store, clock, agent, actions, scheduler, messenger, assigner, devPanel, consoleTransport });

setInterval(() => { void scheduler.tick(clock.now()); }, config.tickMs);
serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Let'sGrow running at ${config.publicBaseUrl}  (messenger: ${messenger.mode}, model: ${llm.label}, dev panel: ${devPanel ? "on" : "off"})`);
  if (llm.label === "none") console.warn("No LLM configured: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in .env.");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => { await messenger.stop(); process.exit(0); });
}
