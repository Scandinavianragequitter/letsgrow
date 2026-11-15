function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num("PORT", 3000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  // LLM: Claude runs the agents. Gemini is used only if there is no Claude key.
  llm: {
    geminiKey: process.env.GEMINI_API_KEY ?? "",
    geminiModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
    anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
    // Claude's built-in web search: max searches per agent turn (0 = off).
    webSearchMaxUses: Number(process.env.WEB_SEARCH_MAX_USES ?? 3),
  },
  messenger: (process.env.MESSENGER ?? "console") as "console" | "photon",
  // Photon Beta (2.0): project ID (pho_prj_...) + project API key. PROJECT_ID is accepted as an alias.
  projectId: process.env.PHOTON_PROJECT_ID || process.env.PROJECT_ID || "",
  photonApiKey: process.env.PHOTON_API_KEY ?? "",
  // Google sign-in for Calendar + Gmail (Google Cloud OAuth client, type "Web application").
  // The redirect URI must be registered on that client exactly. Default works when you click the link on this laptop.
  google: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/oauth/google/callback`,
  } : undefined,
  syncMinutes: num("SYNC_MINUTES", 10),
  sharedLineNumber: process.env.SHARED_LINE_NUMBER ?? "+16289988199",
  durationDays: num("DURATION_DAYS", 60),
  defaultTz: process.env.DEFAULT_TZ ?? "America/New_York",
  timeScale: num("DEMO_TIME_SCALE", 1),
  /** Unlocks /presenter (simulate a slip on stage) on the live site. Empty = off unless the dev panel is on. */
  presenterKey: process.env.PRESENTER_KEY ?? "",
  /** Tell the friend on the very first miss, no grace period (demo). INSTANT_NUDGE=0 lets the agent choose. */
  instantNudge: (process.env.INSTANT_NUDGE ?? "1") !== "0",
  /** How often email habits are checked, in seconds (20 for a live demo). Calendars use syncMinutes. */
  mailSyncSeconds: Number(process.env.MAIL_SYNC_SECONDS ?? 60),
  mockAutofill: (process.env.MOCK_AUTOFILL ?? "1") !== "0",
  dbPath: process.env.DB_PATH ?? "./data/letsgrow.db",
  tickMs: 5_000,
};
