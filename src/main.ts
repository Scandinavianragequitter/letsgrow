import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { Clock } from "./clock.js";
import { Store } from "./db.js";
import { MockIntegrations } from "./integrations/mock.js";
import { AnthropicLlm, MissingKeyLlm, RuleBasedLlm } from "./agent/llm.js";
import { Planner } from "./agent/planner.js";
import { Scheduler } from "./engine/scheduler.js";
import { InboundRouter } from "./engine/inbound.js";
import { ConsoleMessenger, type Messenger } from "./messaging/messenger.js";
import { PhotonBetaMessenger, photonClient } from "./messaging/photon-beta.js";
import { ConsoleAssigner, PhotonAssigner, type LineAssigner } from "./messaging/assigner.js";
import { createApp, INVITE_TEXT } from "./web/server.js";
import { Planning } from "./engine/planning.js";

const store = new Store(config.dbPath);
const clock = new Clock(config.timeScale);
const integrations = new MockIntegrations(store, config.mockAutofill);
const llm = config.anthropicKey ? new AnthropicLlm(config.anthropicKey, config.anthropicModel)
  : process.env.LLM_MOCK === "1" ? new RuleBasedLlm() : new MissingKeyLlm();
const planner = new Planner(llm, integrations);

let messenger: Messenger;
let assigner: LineAssigner;
if (config.messenger === "photon") {
  if (!config.projectId || !config.photonApiKey) {
    console.error("MESSENGER=photon needs PHOTON_PROJECT_ID (pho_prj_...) and PHOTON_API_KEY in .env");
    process.exit(1);
  }
  messenger = new PhotonBetaMessenger({ client: photonClient(config.photonApiKey), projectId: config.projectId, store, now: () => clock.now() });
  assigner = new PhotonAssigner(config.photonApiKey, config.projectId, config.sharedLineNumber);
} else {
  messenger = new ConsoleMessenger(store, () => clock.now());
  assigner = new ConsoleAssigner(config.sharedLineNumber);
}

const planning = new Planning({ store, planner, durationDays: config.durationDays, now: () => clock.now() });
const router = new InboundRouter(store, messenger, () => clock.now(), {
  planning, inviteText: (token) => `${INVITE_TEXT} ${config.publicBaseUrl}/join/${token}`,
});
await messenger.start((e) => router.handle(e));
const scheduler = new Scheduler({ store, integrations, messenger, publicBaseUrl: config.publicBaseUrl });

const devPanel = config.messenger === "console" || process.env.DEV_PANEL === "1";
const app = createApp({ store, clock, planner, scheduler, router, messenger, assigner, devPanel, planning });

setInterval(() => { void scheduler.tick(clock.now()); }, config.tickMs);
serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Let'sGrow running at ${config.publicBaseUrl}  (messenger: ${messenger.mode}, dev panel: ${devPanel ? "on" : "off"})`);
  if (!config.anthropicKey) console.warn(process.env.LLM_MOCK === "1" ? "LLM_MOCK=1: using the keyword-based stand-in planner (set ANTHROPIC_API_KEY for the real agent)." : "ANTHROPIC_API_KEY not set: the habit agent chat will return an error until you add it.");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => { await messenger.stop(); process.exit(0); });
}
