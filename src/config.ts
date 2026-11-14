/**
 * Process configuration, read once at boot from the environment.
 *
 * `npm start` runs `tsx --env-file=.env`, so everything here comes from `.env`.
 * PROJECT_SECRET is read and handed to Spectrum and is never logged, printed
 * or written to the state file.
 */

export interface Config {
  /** Photon project id (`pho_prj_…`). Not a secret, but not logged either. */
  readonly projectId: string;
  /** Photon project secret. Never log this value. */
  readonly projectSecret: string;
  /** Default minutes between proactive heartbeat texts to one chat. */
  readonly heartbeatMinutes: number;
  /** Master switch — `HEARTBEAT_ENABLED=0` runs the agent reply-only. */
  readonly heartbeatEnabled: boolean;
  /** How often the scheduler wakes to look for due heartbeats. */
  readonly tickSeconds: number;
  /** How often the inbound poll runs. */
  readonly pollSeconds: number;
  /**
   * Per-request timeout. The default is generous because the messages
   * endpoint has been measured taking well over ten seconds, and a timeout
   * mid-send is the one failure that costs a round trip to diagnose.
   */
  readonly requestTimeoutMs: number;
  /** Where the known-space registry is persisted. */
  readonly stateFile: string;
  /**
   * Serve only the chats on this line, e.g. "+16289988199". Unset serves every
   * line the project holds. The filter is deliberately fail-closed: a chat
   * whose line we have not recorded is skipped rather than assumed to match,
   * because the cost of guessing wrong is texting a stranger's thread.
   */
  readonly agentLine: string | undefined;
  /**
   * OpenRouter key. Absent is a supported mode: the agent still answers
   * commands and still sends heartbeats, it just cannot hold a conversation.
   */
  readonly openrouterKey: string | undefined;
  /** Models in priority order. Every entry should end in `:free`. */
  readonly models: readonly string[];
  /** File holding the system prompt, so wording needs no code change. */
  readonly promptFile: string;
  readonly llmTimeoutMs: number;
  readonly llmMaxTokens: number;
  /**
   * Consecutive send failures after which a chat is parked rather than
   * retried every tick. The shared-line permission ("has messaged the line
   * since the assignment") is the expected reason a previously fine chat
   * starts rejecting sends, and hammering it would just repeat the error.
   */
  readonly maxConsecutiveFailures: number;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is missing. Copy .env.example to .env and fill it in, then run \`npm start\`.`,
    );
  }
  return value;
}

function numberEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be a number >= ${min}; got ${JSON.stringify(raw)}.`);
  }
  return parsed;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean-ish value; got ${JSON.stringify(raw)}.`);
}

export function loadConfig(): Config {
  return {
    projectId: requireEnv("PROJECT_ID"),
    projectSecret: requireEnv("PROJECT_SECRET"),
    heartbeatMinutes: numberEnv("HEARTBEAT_MINUTES", 60, 1),
    heartbeatEnabled: boolEnv("HEARTBEAT_ENABLED", true),
    tickSeconds: numberEnv("HEARTBEAT_TICK_SECONDS", 20, 1),
    pollSeconds: numberEnv("POLL_SECONDS", 3, 1),
    requestTimeoutMs: numberEnv("REQUEST_TIMEOUT_MS", 30_000, 1000),
    stateFile: process.env.STATE_FILE?.trim() || "state.json",
    agentLine: process.env.AGENT_LINE?.trim() || undefined,
    openrouterKey: process.env.OPENROUTER_API_KEY?.trim() || undefined,
    models: [
      process.env.OPENROUTER_MODEL?.trim() || "nvidia/nemotron-3.5-lightning:free",
      process.env.OPENROUTER_FALLBACK_MODEL?.trim() || "google/gemma-4-31b-it:free",
    ],
    promptFile: process.env.SYSTEM_PROMPT_FILE?.trim() || "prompt.md",
    llmTimeoutMs: numberEnv("LLM_TIMEOUT_MS", 20_000, 1000),
    llmMaxTokens: numberEnv("LLM_MAX_TOKENS", 400, 16),
    maxConsecutiveFailures: numberEnv("HEARTBEAT_MAX_FAILURES", 3, 1),
  };
}
