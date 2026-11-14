import {
  AnthropicRejectedError,
  completeWithClaude,
  costMicros,
  type ChatMessage,
  type CompleteFn,
} from '@/app-layer/ai/anthropic';
import {
  assertAssistantEnabled,
  assistantMemoryEnabled,
  assistantModel,
} from '@/app-layer/ai/assistant/config';
import { emitAnswer } from '@/app-layer/ai/assistant/emit-answer';
import { endingEvent, type HaltCode } from '@/app-layer/ai/assistant/endings';
import {
  contextBlock,
  profileBlock,
  systemPrompt,
  type AssistantLocale,
} from '@/app-layer/ai/assistant/prompt';
import { sseFormat, type AssistantStreamEvent } from '@/app-layer/ai/assistant/stream-events';
import { AssistantDeclinedError, runToolLoop } from '@/app-layer/ai/assistant/tool-loop';
import { toolDefs } from '@/app-layer/ai/assistant/tools';
import { sanitizeUntrusted } from '@/app-layer/ai/safety/sanitize-untrusted';
import type { AssistantAsk } from '@/app-layer/schemas/assistant';
import { playsAsPlayer } from '@/lib/auth/account-kind';
import { runAsUserOnly } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';
import { sanitizePlainText } from '@/lib/security/sanitize';

import {
  loadWindow,
  recordTurn,
  renderWindow,
  resolveConversation,
} from './assistant-conversation';
import { rememberedPointsForPrompt } from './assistant-memory';
import { AssistantSpendCeilingError, assertWithinSpendCap, recordSpend } from './assistant-spend';
import type { SyncDeps } from './google-calendar-sync';

/**
 * One question to «Асистент» (owner 2026-11-14, #704), from the checks that
 * decide whether it may be asked to the `done` event (agri-saas
 * `assistant/stream/route.ts`, adapted from farm to person).
 *
 *   1. `prepareAsk`, BEFORE the stream opens: the feature is on, and the
 *      caller is an account that plays (404 / 403, ordinary HTTP errors).
 *   2. `streamAsk`, inside the stream: `conversation` first, `thinking`, the
 *      question recorded, the bounded tool loop (each model call checked
 *      against the daily cap and charged after), the answer through the
 *      egress scan, a halt if the answer is incomplete, the answer recorded,
 *      `done`. A failure ends as a halt or refusal with its reason, never as
 *      a dropped socket.
 */

export class AssistantPlayersOnlyError extends Error {
  constructor() {
    super('The assistant is for player accounts.');
    this.name = 'AssistantPlayersOnlyError';
  }
}

export async function prepareAsk(userId: string): Promise<{ locale: AssistantLocale }> {
  assertAssistantEnabled();
  const user = await runAsUserOnly(userId, (db) =>
    db.user.findUnique({ where: { id: userId }, select: { accountKind: true, locale: true } }),
  );
  if (!user || !playsAsPlayer(user.accountKind)) throw new AssistantPlayersOnlyError();
  return { locale: user.locale === 'en' ? 'en' : 'bg' };
}

/** The answering call, bounded: thinking stays on (it cannot be turned off on Opus 5.5) at low effort. */
export const ANSWER_MAX_TOKENS = 8_000;

export interface StreamAskInput {
  userId: string;
  locale: AssistantLocale;
  ask: AssistantAsk;
  send: (chunk: string) => void;
  /** Aborted when the phone goes away. */
  signal: AbortSignal;
  /** The model; tests hand in a fake. */
  complete?: CompleteFn;
  /** Google's fetch for the calendar checks; tests hand in a fake. */
  calendar?: SyncDeps;
  now?: () => Date;
}

export async function streamAsk(input: StreamAskInput): Promise<void> {
  const { userId, locale, send, signal } = input;
  const emit = (e: AssistantStreamEvent) => send(sseFormat(e));
  const clock = input.now ?? (() => new Date());
  const complete = input.complete ?? ((req) => completeWithClaude(req));
  const memoryOn = assistantMemoryEnabled();
  const started = Date.now();

  try {
    // FIRST, before any work: an app that loses the stream still holds the id.
    const conversationId = await resolveConversation(userId, input.ask.conversationId);
    emit({ type: 'conversation', conversationId });
    emit({ type: 'thinking' });

    // Sanitised for the renderer (it is stored and listed) THEN for the model;
    // the one value is what both see (agri-saas #2698).
    const question = sanitizeUntrusted(sanitizePlainText(input.ask.message));
    await recordTurn(userId, conversationId, 'user', question);

    const window = await loadWindow(userId, conversationId);
    const history = renderWindow(window.slice(0, -1));
    const profile = memoryOn ? profileBlock(await rememberedPointsForPrompt(userId)) : null;
    const now = clock();

    const system = systemPrompt(locale);
    const tools = toolDefs(memoryOn);
    const model = assistantModel();

    const initial: ChatMessage[] = [
      ...(profile ? [{ role: 'user' as const, content: profile }] : []),
      ...(history ? [{ role: 'user' as const, content: history }] : []),
      {
        role: 'user',
        content: contextBlock({
          now,
          ...(input.ask.page ? { page: input.ask.page } : {}),
          hasLocation: !!input.ask.location,
        }),
      },
      { role: 'user', content: question },
    ];

    const loop = await runToolLoop(
      {
        ctx: {
          userId,
          now,
          location: input.ask.location ?? null,
          ...(input.ask.page ? { page: input.ask.page } : {}),
          ...(input.calendar ? { calendar: input.calendar } : {}),
        },
        memoryOn,
        tools,
        send,
        complete: async (messages, toolChoice) => {
          // The cap, before EVERY call: a question that crosses it stops here.
          await assertWithinSpendCap(userId, clock());
          const c = await complete({
            model,
            system,
            messages,
            tools,
            toolChoice,
            maxTokens: ANSWER_MAX_TOKENS,
            effort: 'low',
            signal,
          });
          await recordSpend(userId, costMicros(c.model, c.usage), clock());
          return c;
        },
      },
      initial,
    );

    const answered = emitAnswer(send, loop.text, { locale, proposal: loop.proposal });
    // The halt follows the answer it qualifies, and only a SENT one.
    if (answered.sent && loop.halt) emit(endingEvent(loop.halt, locale));
    // Only a sent answer becomes a turn: a refusal is not something it said.
    if (answered.sent) {
      await recordTurn(userId, conversationId, 'assistant', sanitizePlainText(loop.text));
    }
    emit({ type: 'done', truncatedAny: loop.truncatedAny, partialAny: loop.partialAny });
  } catch (err) {
    if (signal.aborted) {
      // The phone left. Nobody is listening; nothing to tell.
      logger.info('assistant.client_disconnected', {
        component: 'assistant',
        elapsedMs: Date.now() - started,
      });
      return;
    }
    if (err instanceof AssistantDeclinedError) {
      emit(endingEvent('ASSISTANT_DECLINED', locale));
      emit({ type: 'done', truncatedAny: false, partialAny: false });
      return;
    }
    const code: HaltCode =
      err instanceof AssistantSpendCeilingError
        ? 'ASSISTANT_SPEND_CEILING'
        : err instanceof AnthropicRejectedError
          ? 'ASSISTANT_REQUEST_REJECTED'
          : 'ASSISTANT_PROVIDER_UNAVAILABLE';
    logger.warn('assistant.ended_early', {
      component: 'assistant',
      endingCode: code,
      error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : String(err),
    });
    emit(endingEvent(code, locale));
    emit({ type: 'done', truncatedAny: false, partialAny: false });
  }
}
