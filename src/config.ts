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
  /** Where the known-space registry is persisted. */
  readonly stateFile: string;
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
    stateFile: process.env.STATE_FILE?.trim() || "state.json",
    maxConsecutiveFailures: numberEnv("HEARTBEAT_MAX_FAILURES", 3, 1),
  };
}
