import type { ChatMessage, Completion, ContentBlock } from '@/app-layer/ai/anthropic';
import {
  MAX_TOOL_CALLS,
  runToolLoop,
  AssistantDeclinedError,
} from '@/app-layer/ai/assistant/tool-loop';
import { runTool } from '@/app-layer/ai/assistant/tools';

jest.mock('@/app-layer/ai/assistant/tools', () => ({ runTool: jest.fn() }));
const mockRunTool = runTool as jest.MockedFunction<typeof runTool>;

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const text = (t: string): Completion => ({
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: t },
  ],
  text: t,
  toolUses: [],
  stopReason: 'end_turn',
  model: 'claude-opus-5-5',
  usage,
});
const calls = (...names: string[]): Completion => {
  const toolUses = names.map((name, i) => ({ id: `tu_${name}_${i}`, name, input: { n: i } }));
  return {
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      ...toolUses.map((t) => ({ type: 'tool_use', ...t }) as ContentBlock),
    ],
    text: '',
    toolUses,
    stopReason: 'tool_use',
    model: 'claude-opus-5-5',
    usage,
  };
};

function harness(script: Completion[]) {
  const sent: string[] = [];
  const seen: Array<{ messages: ChatMessage[]; toolChoice: string }> = [];
  const complete = jest.fn(async (messages: ChatMessage[], toolChoice: 'auto' | 'none') => {
    seen.push({ messages: JSON.parse(JSON.stringify(messages)), toolChoice });
    const next = script.shift();
    if (!next) throw new Error('script ran out');
    return next;
  });
  const events = () => sent.map((s) => JSON.parse(s.replace(/^data: /, '')) as { type: string });
  return {
    sent,
    seen,
    events,
    run: () =>
      runToolLoop(
        {
          ctx: { userId: 'u', now: new Date(), location: null },
          memoryOn: true,
          tools: [],
          complete,
          send: (c) => sent.push(c),
        },
        [{ role: 'user', content: 'q' }],
      ),
  };
}

beforeEach(() => {
  mockRunTool.mockReset();
  mockRunTool.mockImplementation(async (_ctx, name) => ({
    ok: true,
    content: `{"from":"${name}"}`,
    truncated: false,
    partial: false,
    proposal: name === 'find_free_places' ? { kind: 'booking', draft: { venueId: 'v' } } : null,
  }));
});

describe('the bounded tool loop', () => {
  it('a question with no tool call is answered at once', async () => {
    const h = harness([text('Здрасти! Как да те наричам?')]);
    const r = await h.run();
    expect(r).toMatchObject({
      text: 'Здрасти! Как да те наричам?',
      halt: null,
      toolCallsMade: 0,
      proposal: null,
    });
    expect(h.events()).toEqual([]);
  });

  it('replays the assistant turn unchanged, thinking included, then every result in ONE user message', async () => {
    const h = harness([calls('find_free_places', 'best_time_for_game'), text('Ето.')]);
    const r = await h.run();
    expect(r.text).toBe('Ето.');
    expect(r.proposal).toEqual({ kind: 'booking', draft: { venueId: 'v' } });
    const second = h.seen[1]!.messages;
    expect(second).toHaveLength(3);
    expect(second[1]).toEqual({
      role: 'assistant',
      content: calls('find_free_places', 'best_time_for_game').content,
    });
    expect(second[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_find_free_places_0',
          content: '{"from":"find_free_places"}',
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu_best_time_for_game_1',
          content: '{"from":"best_time_for_game"}',
        },
      ],
    });
    expect(h.events().map((e) => e.type)).toEqual([
      'tool_call',
      'tool_call',
      'tool_result',
      'tool_result',
    ]);
  });

  it('a failed tool goes back to the model as an error, not to the stream as an ending', async () => {
    mockRunTool.mockResolvedValueOnce({
      ok: false,
      content: 'not one of the person’s bookings',
      truncated: false,
      partial: false,
      proposal: null,
    });
    const h = harness([calls('best_time_for_game'), text('Не виждам тази игра.')]);
    const r = await h.run();
    expect(r.halt).toBeNull();
    const results = h.seen[1]!.messages[2]!.content as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ is_error: true });
    expect(h.events()[1]).toMatchObject({ type: 'tool_result', ok: false });
  });

  it('over the budget: every call still gets a result, and the last call may not call tools', async () => {
    const many = Array.from({ length: MAX_TOOL_CALLS + 2 }, () => 'find_free_places');
    const h = harness([calls(...many), text('Каквото намерих.')]);
    const r = await h.run();
    expect(r.halt).toBe('ASSISTANT_TOOL_BUDGET');
    expect(mockRunTool).toHaveBeenCalledTimes(MAX_TOOL_CALLS);
    const results = h.seen[1]!.messages[2]!.content as Array<Record<string, unknown>>;
    expect(results).toHaveLength(MAX_TOOL_CALLS + 2);
    expect(results.slice(MAX_TOOL_CALLS).every((b) => b.is_error === true)).toBe(true);
    expect(h.seen[1]!.toolChoice).toBe('none');
    expect(r.text).toBe('Каквото намерих.');
  });

  it('truncated and partial results halt in that order, and both are reported', async () => {
    mockRunTool.mockResolvedValueOnce({
      ok: true,
      content: '{}',
      truncated: true,
      partial: true,
      proposal: null,
    });
    const h = harness([calls('best_time_for_game'), text('Част.')]);
    const r = await h.run();
    expect(r).toMatchObject({
      halt: 'ASSISTANT_TRUNCATED_RESULT',
      truncatedAny: true,
      partialAny: true,
    });
  });

  it('the time budget stops the tools, not the answer', async () => {
    let t = 0;
    const sent: string[] = [];
    const complete = jest
      .fn()
      .mockImplementationOnce(async () => {
        t += 30_000;
        return calls('find_free_places');
      })
      .mockImplementationOnce(async () => text('Бавно, но ето.'));
    const r = await runToolLoop(
      {
        ctx: { userId: 'u', now: new Date(), location: null },
        memoryOn: false,
        tools: [],
        complete,
        send: (c) => sent.push(c),
        now: () => t,
      },
      [{ role: 'user', content: 'q' }],
    );
    expect(r).toMatchObject({ halt: 'ASSISTANT_TIME_BUDGET', text: 'Бавно, но ето.' });
    expect(complete.mock.calls[1]![1]).toBe('none');
  });

  it('a model decline is a refusal, not an answer', async () => {
    const h = harness([{ ...text(''), stopReason: 'refusal' }]);
    await expect(h.run()).rejects.toBeInstanceOf(AssistantDeclinedError);
  });
});
