/**
 * The ONE place an assistant answer reaches a client (agri-saas #2578).
 *
 * The egress scan is not a step a caller must remember: it is the only way to
 * build the `answer` event. `{ type: 'answer'` is spelled here and nowhere
 * else (tests/guardrails/assistant-answer-goes-through-the-scan.test.ts).
 *
 * The draft is scanned with the text: it is outgoing too. A dirty verdict
 * DISCARDS the answer, never redacts it, and logs rule names only.
 */
import { logger } from '@/lib/observability/logger';

import { scanEgress } from '../safety/egress-scan';

import { endingEvent } from './endings';
import type { AssistantLocale } from './prompt';
import type { AssistantProposal } from './propose';
import { sseFormat, type AssistantStreamEvent } from './stream-events';

export interface AnswerOutcome {
  readonly sent: boolean;
  readonly ruleIds: readonly string[];
}

export function emitAnswer(
  send: (chunk: string) => void,
  text: string,
  meta: { locale: AssistantLocale; proposal: AssistantProposal | null },
): AnswerOutcome {
  const trimmed = text.trim();
  if (trimmed === '') {
    send(sseFormat(endingEvent('ASSISTANT_NO_GROUNDING', meta.locale)));
    return { sent: false, ruleIds: [] };
  }
  const verdict = scanEgress(
    [trimmed, ...(meta.proposal ? [JSON.stringify(meta.proposal.draft)] : [])].join('\n'),
  );
  if (!verdict.clean) {
    logger.warn('assistant.egress_blocked', {
      component: 'assistant',
      ruleIds: verdict.ruleIds.join(','),
    });
    send(sseFormat(endingEvent('ASSISTANT_EGRESS_BLOCKED', meta.locale)));
    return { sent: false, ruleIds: verdict.ruleIds };
  }
  const event: AssistantStreamEvent = {
    type: 'answer',
    text: trimmed,
    ...(meta.proposal ? { proposal: meta.proposal } : {}),
  };
  send(sseFormat(event));
  return { sent: true, ruleIds: [] };
}
