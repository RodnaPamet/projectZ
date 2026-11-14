/**
 * The Claude Messages API, over `fetch` (owner 2026-11-14, #704).
 *
 * The same transport the moderation classifier uses (src/lib/moderation/
 * classify.ts): one POST, no SDK, so the app takes no new dependency and a
 * test fakes the provider with a function. agri-saas reaches Claude through
 * its provider layer; this is the part of it the assistant needs: messages
 * with tool use, a cached system block, and the usage to bill.
 *
 * ## What is sent, and why
 *
 * - `anthropic-version: 2026-10-21`. That version refuses `temperature`,
 *   `top_p` and `top_k`, so none is sent.
 * - The system prompt is ONE block with `cache_control`: tools render before
 *   it, so the tool list and the rules are one cached prefix for everybody.
 *   Everything that varies (the profile, today's date, the screen) comes after.
 * - `output_config.effort: low` on the answering model: the tools do the
 *   reasoning about times, and the phone is waiting.
 * - `fallbacks: "default"` on the models that take it: a classifier decline
 *   is retried server-side on the model Anthropic recommends, rather than
 *   reaching the person as nothing. Haiku takes no fallbacks.
 * - The ASSISTANT turn that made tool calls is replayed with its content
 *   blocks UNCHANGED, thinking blocks included, before the `tool_result`
 *   user turn, and every result of one round goes in ONE user message —
 *   agri-saas #2654's two halves, which each broke every tool round.
 */

export const ANTHROPIC_VERSION = '2026-10-21';
export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/** A content block as the API speaks it. Unknown kinds (thinking, fallback) pass through untouched. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [key: string]: unknown };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Completion {
  /** The response's content blocks, to replay unchanged on the next call. */
  content: ContentBlock[];
  /** The text blocks joined: the answer, when there are no tool calls. */
  text: string;
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  stopReason: string | null;
  /** The model that actually answered (a fallback may differ from the one asked). */
  model: string;
  usage: Usage;
}

export interface CompleteRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** `none`: the tools stay defined (the history holds tool calls) but none may be called. */
  toolChoice?: 'auto' | 'none';
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
  /** Structured output: the answer is JSON matching this schema. */
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The function the assistant calls; a test hands in its own. */
export type CompleteFn = (req: CompleteRequest) => Promise<Completion>;

/** The model could not be reached: no key, a network failure, a timeout, a 429 or a 5xx. */
export class AnthropicUnavailableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AnthropicUnavailableError';
  }
}

/** The model was reached and refused the request (a 4xx other than 429). */
export class AnthropicRejectedError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AnthropicRejectedError';
  }
}

/** Models that take `fallbacks: "default"` (Claude API). Haiku does not. */
function takesFallbacks(model: string): boolean {
  return /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);
}

/** Models with `output_config.effort`. Haiku 4.5 and older errors on it. */
function takesEffort(model: string): boolean {
  return !/^claude-haiku-4|^claude-(sonnet|opus)-4-[0-5]\b/.test(model);
}

export function buildRequestBody(req: CompleteRequest): Record<string, unknown> {
  const outputConfig: Record<string, unknown> = {};
  if (req.effort && takesEffort(req.model)) outputConfig.effort = req.effort;
  if (req.jsonSchema) outputConfig.format = { type: 'json_schema', schema: req.jsonSchema };
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: req.messages,
    ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
    ...(req.tools && req.tools.length > 0 && req.toolChoice
      ? { tool_choice: { type: req.toolChoice } }
      : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    ...(takesFallbacks(req.model) ? { fallbacks: 'default' } : {}),
  };
}

interface RawResponse {
  model?: string;
  content?: ContentBlock[];
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export function parseResponse(json: RawResponse, asked: string): Completion {
  const content = Array.isArray(json.content) ? json.content : [];
  const text = content
    .filter(
      (b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string',
    )
    .map((b) => b.text)
    .join('');
  const toolUses = content
    .filter((b) => b.type === 'tool_use')
    .map((b) => {
      const t = b as { id: string; name: string; input: unknown };
      return { id: String(t.id), name: String(t.name), input: t.input ?? {} };
    });
  const u = json.usage ?? {};
  return {
    content,
    text,
    toolUses,
    stopReason: json.stop_reason ?? null,
    model: json.model ?? asked,
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}

/** One Messages call. Throws `AnthropicUnavailableError` or `AnthropicRejectedError`, never returns a guess. */
export async function completeWithClaude(
  req: CompleteRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<Completion> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AnthropicUnavailableError('ANTHROPIC_API_KEY is not set');

  const timeout = AbortSignal.timeout(req.timeoutMs ?? 60_000);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const fallbacks = takesFallbacks(req.model);

  let res: Response;
  try {
    res = await fetchImpl(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        ...(fallbacks ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
      },
      body: JSON.stringify(buildRequestBody(req)),
      signal,
    });
  } catch (e) {
    throw new AnthropicUnavailableError(e instanceof Error ? e.message : 'network error');
  }

  if (!res.ok) {
    // The body names the cause; only the status is kept, so a log line cannot
    // carry whatever the request held.
    await res.text().catch(() => '');
    if (res.status === 429 || res.status >= 500) {
      throw new AnthropicUnavailableError(`HTTP ${res.status}`, res.status);
    }
    throw new AnthropicRejectedError(`HTTP ${res.status}`, res.status);
  }
  return parseResponse((await res.json()) as RawResponse, req.model);
}

// ─── What it cost ─────────────────────────────────────────────────────────

interface Price {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
}

/** First-party list prices (2026-10). Longest matching prefix wins. */
const PRICES: Record<string, Price> = {
  'claude-fable-5': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.1 },
};

/** An unknown model is charged at the dearest price: the cap must not open because a name is new. */
const UNKNOWN_PRICE: Price = { input: 10, output: 50, cacheRead: 1 };

export function priceOf(model: string): Price {
  let best: Price | null = null;
  let bestLen = 0;
  for (const [prefix, price] of Object.entries(PRICES)) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = price;
      bestLen = prefix.length;
    }
  }
  return best ?? UNKNOWN_PRICE;
}

/** Micro-dollars. Cache writes at 1.25× input, reads at the model's cache price. */
export function costMicros(model: string, usage: Usage): number {
  const p = priceOf(model);
  return Math.ceil(
    usage.inputTokens * p.input +
      usage.cacheWriteTokens * p.input * 1.25 +
      usage.cacheReadTokens * p.cacheRead +
      usage.outputTokens * p.output,
  );
}
