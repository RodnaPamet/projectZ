import { type NextRequest } from 'next/server';

import { assertAssistantEnabled } from '@/app-layer/ai/assistant/config';
import {
  deletePastConversation,
  getPastConversation,
} from '@/app-layer/usecases/assistant-conversations-control';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { noContent, ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * One past conversation (owner 2026-11-14, #704).
 *
 * GET    → `{ id, startedAt, lastTurnAt, turns, items: [{ role, text, at }],
 *          truncated }`, oldest turn first, at most the last 200. Send its
 *          `id` as `conversationId` to continue it.
 * DELETE → 204.
 *
 * 404 `ASSISTANT_CONVERSATION_NOT_FOUND` for an id that is not the caller's.
 */
async function caller(req: NextRequest): Promise<string> {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  assertAssistantEnabled();
  return ctx.userId;
}

async function get(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await caller(req);
  const { id } = await params;
  return ok(await getPastConversation(userId, id));
}

async function remove(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await caller(req);
  const { id } = await params;
  await deletePastConversation(userId, id);
  return noContent();
}

export const GET = defineV1Route(get);
export const DELETE = defineV1Route(remove);
