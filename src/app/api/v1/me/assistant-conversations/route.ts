import { type NextRequest } from 'next/server';

import { assertAssistantEnabled } from '@/app-layer/ai/assistant/config';
import {
  deleteAllPastConversations,
  listPastConversations,
} from '@/app-layer/usecases/assistant-conversations-control';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * The caller's past conversations with «Асистент» (owner 2026-11-14, #704).
 *
 * GET    → `{ items: [{ id, startedAt, lastTurnAt, turns, opening }] }`,
 *          latest first, at most 50; `opening` is the first question.
 * DELETE → every conversation deleted: gone from the list, from recall and
 *          from the assistant's context. `{ deleted: n }`.
 */
async function caller(req: NextRequest): Promise<string> {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  assertAssistantEnabled();
  return ctx.userId;
}

async function list(req: NextRequest) {
  return ok({ items: await listPastConversations(await caller(req)) });
}

async function removeAll(req: NextRequest) {
  return ok({ deleted: await deleteAllPastConversations(await caller(req)) });
}

export const GET = defineV1Route(list);
export const DELETE = defineV1Route(removeAll);
