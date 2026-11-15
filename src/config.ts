function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num("PORT", 3000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  // LLM: Anthropic or any OpenRouter model. LLM_PROVIDER picks one; if empty, whichever key is set.
  llm: {
    provider: process.env.LLM_PROVIDER ?? "",
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
    anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
    openrouterKey: process.env.OPENROUTER_API_KEY ?? "",
    openrouterModel: process.env.OPENROUTER_MODEL || "openrouter/free",
    // Claude's built-in web search: max searches per agent turn (0 = off). Anthropic only.
    webSearchMaxUses: Number(process.env.WEB_SEARCH_MAX_USES ?? 3),
  },
  messenger: (process.env.MESSENGER ?? "console") as "console" | "photon",
  // Photon Beta (2.0): project ID (pho_prj_...) + project API key. PROJECT_ID is accepted as an alias.
  projectId: process.env.PHOTON_PROJECT_ID || process.env.PROJECT_ID || "",
  photonApiKey: process.env.PHOTON_API_KEY ?? "",
  sharedLineNumber: process.env.SHARED_LINE_NUMBER ?? "+16289988199",
  durationDays: num("DURATION_DAYS", 60),
  defaultTz: process.env.DEFAULT_TZ ?? "America/New_York",
  timeScale: num("DEMO_TIME_SCALE", 1),
  mockAutofill: (process.env.MOCK_AUTOFILL ?? "1") !== "0",
  dbPath: process.env.DB_PATH ?? "./data/letsgrow.db",
  tickMs: 5_000,
};
