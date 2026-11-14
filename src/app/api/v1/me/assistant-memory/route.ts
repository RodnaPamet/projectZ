import { type NextRequest } from 'next/server';

import { assertAssistantEnabled } from '@/app-layer/ai/assistant/config';
import {
  forgetAllRememberedPoints,
  listRememberedPoints,
} from '@/app-layer/usecases/assistant-memory';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * «Какво помни асистентът» (owner 2026-11-14, #704).
 *
 * GET    → `{ items: [{ id, text, rememberedAt, editedByPerson }] }`, newest
 *          first, at most 50. Never the evidence it was learned from.
 * DELETE → «Забрави всичко»: every point forgotten, and never learned again
 *          from what the person already said. `{ forgotten: n }`.
 *
 * 404 `ASSISTANT_DISABLED` while the assistant is off. Readable and deletable
 * while the memory alone is switched off: what is stored stays the person's
 * to see and remove.
 */
async function caller(req: NextRequest): Promise<string> {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  assertAssistantEnabled();
  return ctx.userId;
}

async function list(req: NextRequest) {
  const userId = await caller(req);
  return ok({ items: await listRememberedPoints(userId) });
}

async function forgetAll(req: NextRequest) {
  const userId = await caller(req);
  return ok({ forgotten: await forgetAllRememberedPoints(userId) });
}

export const GET = defineV1Route(list);
export const DELETE = defineV1Route(forgetAll);
