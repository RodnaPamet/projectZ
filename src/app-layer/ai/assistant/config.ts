/**
 * How the assistant is configured (owner 2026-11-14, #704). Read at use, from
 * the environment, so a test or an operator changes it without a rebuild.
 *
 *   ASSISTANT_ENABLED=1             the whole feature; off → 404 ASSISTANT_DISABLED
 *   ANTHROPIC_API_KEY               shared with moderation; absent → every
 *                                   question halts ASSISTANT_PROVIDER_UNAVAILABLE
 *   AI_MODEL                        the answering model (default below)
 *   ASSISTANT_MEMORY_MODEL          the memory sweep's model (default below)
 *   ASSISTANT_MEMORY=0              memory off, assistant still on (rule 9)
 *   ASSISTANT_DAILY_SPEND_CAP_USD   per player per day (default 0.50)
 */

/** The current Opus: the answering model unless `AI_MODEL` names another. */
export const DEFAULT_ASSISTANT_MODEL = 'claude-opus-5-5';

/**
 * The sweep reads a handful of questions and returns a short JSON list, many
 * times a day: the current Haiku is enough, at a fortieth of the price.
 */
export const DEFAULT_MEMORY_MODEL = 'claude-haiku-5-5';

/** Fifty cents a player a day: some ten to twenty questions on the default model. */
export const DEFAULT_DAILY_SPEND_CAP_USD = 0.5;

export class AssistantDisabledError extends Error {
  constructor() {
    super('The assistant is not available.');
    this.name = 'AssistantDisabledError';
  }
}

export function assistantEnabled(): boolean {
  return process.env.ASSISTANT_ENABLED === '1';
}

/** Throws `AssistantDisabledError` (404 `ASSISTANT_DISABLED`) when off. */
export function assertAssistantEnabled(): void {
  if (!assistantEnabled()) throw new AssistantDisabledError();
}

/** Memory rule 9: a separate switch, so memory can stop without the assistant. */
export function assistantMemoryEnabled(): boolean {
  return assistantEnabled() && process.env.ASSISTANT_MEMORY !== '0';
}

export function assistantModel(): string {
  return process.env.AI_MODEL?.trim() || DEFAULT_ASSISTANT_MODEL;
}

export function memoryModel(): string {
  return process.env.ASSISTANT_MEMORY_MODEL?.trim() || DEFAULT_MEMORY_MODEL;
}

/** The daily cap in micro-dollars. A malformed value falls back to the default, never to "unlimited". */
export function dailySpendCapMicros(): number {
  const raw = Number(process.env.ASSISTANT_DAILY_SPEND_CAP_USD);
  const usd = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAILY_SPEND_CAP_USD;
  return Math.round(usd * 1_000_000);
}
