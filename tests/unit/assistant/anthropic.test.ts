import {
  AnthropicRejectedError,
  AnthropicUnavailableError,
  buildRequestBody,
  completeWithClaude,
  costMicros,
  parseResponse,
} from '@/app-layer/ai/anthropic';
import { dailySpendCapMicros } from '@/app-layer/ai/assistant/config';

/** The unit environment has no `Response`; the client reads only these. */
const fakeResponse = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as unknown as Response;

const req = {
  model: 'claude-opus-5-5',
  system: 'rules',
  messages: [{ role: 'user' as const, content: 'q' }],
  tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
  toolChoice: 'none' as const,
  maxTokens: 100,
  effort: 'low' as const,
};

describe('the Claude call', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('caches the system block, sends no sampling parameters, and asks for server-side fallback on Opus', () => {
    const body = buildRequestBody(req);
    expect(body.system).toEqual([
      { type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body.tool_choice).toEqual({ type: 'none' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.fallbacks).toBe('default');
    // Haiku takes no fallbacks.
    expect(buildRequestBody({ ...req, model: 'claude-haiku-5-5' })).not.toHaveProperty('fallbacks');
  });

  it('reads text, tool calls and usage', () => {
    const c = parseResponse(
      {
        model: 'claude-opus-5-5',
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'Търся.' },
          { type: 'tool_use', id: 'tu1', name: 'find_free_places', input: { sport: 'PADEL' } },
        ],
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 },
      },
      'claude-opus-5-5',
    );
    expect(c.text).toBe('Търся.');
    expect(c.toolUses).toEqual([
      { id: 'tu1', name: 'find_free_places', input: { sport: 'PADEL' } },
    ]);
    expect(c.content).toHaveLength(3);
    // 1000×4 + 5000×0.20 + 200×20 = 9000 micro-dollars.
    expect(costMicros(c.model, c.usage)).toBe(9000);
  });

  it('an unknown model is charged at the dearest price, never free', () => {
    expect(
      costMicros('some-new-model', {
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(10_000);
  });

  it('no key, a 429 and a 5xx are "unavailable"; another 4xx is "rejected"', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(completeWithClaude(req, jest.fn())).rejects.toBeInstanceOf(
      AnthropicUnavailableError,
    );
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const status = (s: number) =>
      jest.fn(async () => fakeResponse(s, { error: {} })) as unknown as typeof fetch;
    await expect(completeWithClaude(req, status(429))).rejects.toBeInstanceOf(
      AnthropicUnavailableError,
    );
    await expect(completeWithClaude(req, status(529))).rejects.toBeInstanceOf(
      AnthropicUnavailableError,
    );
    await expect(completeWithClaude(req, status(400))).rejects.toBeInstanceOf(
      AnthropicRejectedError,
    );
  });

  it('sends the version, the fallback beta and the key, and nothing about the person in the headers', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const fetchImpl = jest.fn(async (_url: unknown, _init?: RequestInit) =>
      fakeResponse(200, { content: [{ type: 'text', text: 'ok' }], usage: {} }),
    );
    await completeWithClaude(req, fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init!.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'test-key',
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    });
  });

  it('the daily cap defaults to fifty cents and never reads a bad value as unlimited', () => {
    delete process.env.ASSISTANT_DAILY_SPEND_CAP_USD;
    expect(dailySpendCapMicros()).toBe(500_000);
    process.env.ASSISTANT_DAILY_SPEND_CAP_USD = 'lots';
    expect(dailySpendCapMicros()).toBe(500_000);
    process.env.ASSISTANT_DAILY_SPEND_CAP_USD = '2';
    expect(dailySpendCapMicros()).toBe(2_000_000);
  });
});
