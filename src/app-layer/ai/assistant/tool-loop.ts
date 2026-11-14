/**
 * The bounded tool loop (agri-saas `tool-loop.ts`).
 *
 * Both budgets bound the TOOL phase, never the answer: when one runs out the
 * loop stops calling tools and makes one last call in which no tool may be
 * called, so the model answers from what it gathered and a `halt` always has
 * an answer above it to be incomplete about.
 *
 * One halt per turn, by precedence: TIME > TOOL_BUDGET > TRUNCATED > PARTIAL.
 * Truncation and partial data are also always on `done`, so neither is lost
 * to a higher halt.
 *
 * A failed tool goes back to the MODEL as an error result, never to the
 * stream as an ending. Every `tool_use` gets a `tool_result` — also the calls
 * over the budget, which are answered "not run" — because a call left without
 * one makes the API refuse the whole next request.
 */
import type { ChatMessage, Completion, ContentBlock, ToolDef } from '@/app-layer/ai/anthropic';
import { logger } from '@/lib/observability/logger';

import type { HaltCode } from './endings';
import type { AssistantProposal } from './propose';
import { sseFormat, type AssistantStreamEvent } from './stream-events';
import { runTool, type ToolContext } from './tools';

/** At most four tool calls for one question. */
export const MAX_TOOL_CALLS = 4;
/** Wall-clock bound on the tool phase. */
export const TOOL_PHASE_BUDGET_MS = 25_000;

/** The model declined (a safety stop): no answer, said as a refusal. */
export class AssistantDeclinedError extends Error {
  constructor() {
    super('The model declined to answer.');
    this.name = 'AssistantDeclinedError';
  }
}

export interface ToolLoopResult {
  readonly text: string;
  /** The LAST draft of the turn: a person confirms one form. */
  readonly proposal: AssistantProposal | null;
  readonly truncatedAny: boolean;
  readonly partialAny: boolean;
  readonly halt: HaltCode | null;
  readonly toolCallsMade: number;
}

export interface ToolLoopDeps {
  readonly ctx: ToolContext;
  readonly memoryOn: boolean;
  readonly tools: ToolDef[];
  /** One model call; `toolChoice: 'none'` for the last, tool-less one. */
  readonly complete: (messages: ChatMessage[], toolChoice: 'auto' | 'none') => Promise<Completion>;
  readonly send: (chunk: string) => void;
  readonly now?: () => number;
}

export async function runToolLoop(
  deps: ToolLoopDeps,
  initial: ChatMessage[],
): Promise<ToolLoopResult> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const emit = (e: AssistantStreamEvent) => deps.send(sseFormat(e));

  const messages: ChatMessage[] = [...initial];
  let truncatedAny = false;
  let partialAny = false;
  let toolCallsMade = 0;
  let proposal: AssistantProposal | null = null;
  let halt: HaltCode | null = null;
  let text: string | null = null;

  const answerOf = (c: Completion): string => {
    if (c.stopReason === 'refusal') throw new AssistantDeclinedError();
    return c.text;
  };

  for (let round = 0; round < MAX_TOOL_CALLS; round++) {
    if (now() - started > TOOL_PHASE_BUDGET_MS) {
      halt = 'ASSISTANT_TIME_BUDGET';
      break;
    }
    const completion = await deps.complete(messages, 'auto');
    if (completion.toolUses.length === 0) {
      text = answerOf(completion);
      break;
    }
    // The assistant turn, replayed with its blocks unchanged (thinking too).
    messages.push({ role: 'assistant', content: completion.content });

    const room = Math.max(0, MAX_TOOL_CALLS - toolCallsMade);
    const admitted = completion.toolUses.slice(0, room);
    const refused = completion.toolUses.slice(room);
    toolCallsMade += admitted.length;

    for (const call of admitted) emit({ type: 'tool_call', name: call.name });
    // Independent reads, so in parallel; `runTool` never throws, and the fold
    // below runs in the model's order, so the last draft is the last call's.
    const outcomes = await Promise.all(
      admitted.map((call) => runTool(deps.ctx, call.name, call.input, deps.memoryOn)),
    );

    const results: ContentBlock[] = [];
    admitted.forEach((call, i) => {
      const o = outcomes[i]!;
      if (o.truncated) truncatedAny = true;
      if (o.partial) partialAny = true;
      if (o.proposal) proposal = o.proposal;
      emit({ type: 'tool_result', name: call.name, ok: o.ok, truncated: o.truncated });
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: o.content,
        ...(o.ok ? {} : { is_error: true }),
      });
    });
    for (const call of refused) {
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: 'Not run: the limit of look-ups for one question was reached.',
        is_error: true,
      });
    }
    // Every result of one round in ONE user message.
    messages.push({ role: 'user', content: results });

    if (refused.length > 0 || toolCallsMade >= MAX_TOOL_CALLS) {
      halt = 'ASSISTANT_TOOL_BUDGET';
      break;
    }
  }

  if (text === null) {
    if (halt === null) halt = 'ASSISTANT_TOOL_BUDGET';
    text = answerOf(await deps.complete(messages, 'none'));
  }

  if (halt === null && truncatedAny) halt = 'ASSISTANT_TRUNCATED_RESULT';
  if (halt === null && partialAny) halt = 'ASSISTANT_PARTIAL_DATA';

  logger.info('assistant.turn', {
    component: 'assistant',
    totalMs: now() - started,
    toolCallsMade,
    halt,
  });

  return { text, proposal, truncatedAny, partialAny, halt, toolCallsMade };
}
