/**
 * The OpenRouter client.
 *
 * One model list, tried in order. OpenRouter has its own `models` fallback
 * field, which is sent too, but the loop here is what the tests exercise and
 * what the logs reflect: it works whether or not the server-side field is
 * honoured on this endpoint, and it reports which model actually answered.
 *
 * Billing note that shaped the defaults: OpenRouter bills whichever model
 * answers, so a paid model listed after a free one is charged at the paid
 * price if the free one fails. Every configured model should end in `:free`,
 * and `warnIfNotFree` says so at startup rather than on the invoice.
 */

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface LlmReply {
  text: string;
  /** The model that actually answered, as OpenRouter reports it. */
  model: string;
  ms: number;
}

export interface LlmOptions {
  apiKey: string;
  /** Priority order: the first that answers wins. */
  models: readonly string[];
  systemPrompt: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof globalThis.fetch;
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export class LlmError extends Error {
  constructor(
    message: string,
    readonly attempts: { model: string; reason: string }[],
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export class Llm {
  #options: LlmOptions;

  constructor(options: LlmOptions) {
    this.#options = options;
  }

  get models(): readonly string[] {
    return this.#options.models;
  }

  /**
   * Model ids that would be billed. Checked at startup so a typo like
   * `nemotron-3.5-lightning` (no `:free`) is caught before it bills.
   */
  static paidLooking(models: readonly string[]): string[] {
    return models.filter((m) => !m.endsWith(":free"));
  }

  async reply(history: readonly Turn[]): Promise<LlmReply> {
    const { apiKey, models, systemPrompt, fetchImpl } = this.#options;
    const timeoutMs = this.#options.timeoutMs ?? 20_000;
    const maxTokens = this.#options.maxTokens ?? 400;
    const doFetch = fetchImpl ?? globalThis.fetch;
    const attempts: { model: string; reason: string }[] = [];

    for (const [index, model] of models.entries()) {
      const started = Date.now();
      try {
        const response = await doFetch(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            // Identifies the app on OpenRouter's dashboard. Deliberately
            // generic: nothing here should carry who is running it.
            "X-Title": "page",
          },
          body: JSON.stringify({
            model,
            // OpenRouter's own fallback, covering the rest of the list in one
            // round trip when the endpoint honours it.
            models: models.slice(index),
            messages: [{ role: "system", content: systemPrompt }, ...history],
            max_tokens: maxTokens,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          attempts.push({
            model,
            reason: `HTTP ${response.status} ${body.slice(0, 200).replace(/\s+/g, " ")}`,
          });
          continue;
        }

        const payload: unknown = await response.json();
        const text = extractText(payload);
        if (text === undefined) {
          attempts.push({ model, reason: `no usable content: ${describeChoice(payload)}` });
          continue;
        }

        return {
          text,
          model: extractModel(payload) ?? model,
          ms: Date.now() - started,
        };
      } catch (error) {
        const name = error instanceof Error ? error.name : "Error";
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ model, reason: `${name}: ${message}` });
      }
    }

    throw new LlmError(
      `all ${models.length} model(s) failed: ${attempts
        .map((a) => `${a.model} → ${a.reason}`)
        .join("; ")}`,
      attempts,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * OpenRouter can answer 200 with an error inside the choice, or with an empty
 * string when a model refuses, so a successful status is not a usable reply.
 */
function extractText(payload: unknown): string | undefined {
  const choices = asRecord(payload)?.["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = asRecord(asRecord(choices[0])?.["message"]);
  const content = message?.["content"];
  if (typeof content !== "string") return undefined;
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractModel(payload: unknown): string | undefined {
  const model = asRecord(payload)?.["model"];
  return typeof model === "string" ? model : undefined;
}

function describeChoice(payload: unknown): string {
  const choices = asRecord(payload)?.["choices"];
  const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
  const error = asRecord(first?.["error"]) ?? asRecord(asRecord(payload)?.["error"]);
  if (error) return `error ${String(error["code"] ?? "?")}: ${String(error["message"] ?? "?")}`;
  const finish = first?.["finish_reason"];
  return finish ? `finish_reason=${String(finish)}` : "unrecognized response shape";
}

/**
 * A bounded per-chat transcript. Kept in memory on purpose: message bodies are
 * not written to the registry file, so a restart starts the conversation over
 * rather than leaving texts on disk.
 */
export class History {
  #turns = new Map<string, Turn[]>();
  #limit: number;

  constructor(limit = 12) {
    this.#limit = limit;
  }

  get(spaceId: string): readonly Turn[] {
    return this.#turns.get(spaceId) ?? [];
  }

  append(spaceId: string, turn: Turn): readonly Turn[] {
    const turns = [...(this.#turns.get(spaceId) ?? []), turn].slice(-this.#limit);
    this.#turns.set(spaceId, turns);
    return turns;
  }

  clear(spaceId: string): void {
    this.#turns.delete(spaceId);
  }
}
