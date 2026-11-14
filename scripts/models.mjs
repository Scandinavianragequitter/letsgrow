/**
 * Checks the models this agent is configured to use against OpenRouter's live
 * catalogue, and measures them if a key is present.
 *
 * Free models get retired without notice, so a configuration that worked last
 * month can silently become "all models failed". Run this when replies stop,
 * or when picking a new default:
 *
 *   npm run models
 */

const KEY = process.env.OPENROUTER_API_KEY?.trim();
const CONFIGURED = [
  process.env.OPENROUTER_MODEL?.trim() || "nvidia/nemotron-3.5-lightning:free",
  process.env.OPENROUTER_FALLBACK_MODEL?.trim() || "google/gemma-4-31b-it:free",
];

const catalogue = await fetch("https://openrouter.ai/api/v1/models", {
  signal: AbortSignal.timeout(45_000),
}).then((r) => r.json());

const byId = new Map(catalogue.data.map((m) => [m.id, m]));
const isFree = (m) =>
  Number(m?.pricing?.prompt ?? 1) === 0 && Number(m?.pricing?.completion ?? 1) === 0;
const hasTools = (m) => (m?.supported_parameters ?? []).includes("tools");

console.log("configured:");
let broken = false;
for (const id of CONFIGURED) {
  const model = byId.get(id);
  if (!model) {
    console.log(`  ✗ ${id} — NOT IN THE CATALOGUE (retired or renamed)`);
    broken = true;
    continue;
  }
  const notes = [isFree(model) ? "free" : "BILLABLE", hasTools(model) ? "tools" : "NO TOOLS"];
  if (!isFree(model) || !hasTools(model)) broken = true;
  console.log(`  ${isFree(model) && hasTools(model) ? "✓" : "!"} ${id} — ${notes.join(", ")}, ctx ${model.context_length}`);
}

if (broken) {
  console.log("\nfree models that support tools, widest context first:");
  for (const m of catalogue.data
    .filter((m) => isFree(m) && hasTools(m))
    .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0))) {
    console.log(`  ${m.id}  ctx ${m.context_length}`);
  }
}

if (!KEY) {
  console.log("\nno OPENROUTER_API_KEY in the environment — skipping the latency check");
  process.exit(broken ? 1 : 0);
}

console.log("\nlatency (one short completion each):");
for (const id of CONFIGURED) {
  const started = Date.now();
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        "X-Title": "page",
      },
      body: JSON.stringify({
        model: id,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await response.json().catch(() => ({}));
    const text = body?.choices?.[0]?.message?.content?.trim();
    const ms = Date.now() - started;
    console.log(
      response.ok && text
        ? `  ✓ ${id} — ${ms}ms, answered ${JSON.stringify(text)} (as ${body.model ?? id})`
        : `  ✗ ${id} — ${ms}ms, HTTP ${response.status} ${JSON.stringify(body?.error ?? body?.choices?.[0]?.error ?? "").slice(0, 160)}`,
    );
  } catch (error) {
    console.log(`  ✗ ${id} — ${error.name}: ${error.message}`);
  }
}
