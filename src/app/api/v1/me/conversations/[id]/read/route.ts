import { type NextRequest } from 'next/server';

import { markConversationRead } from '@/app-layer/usecases/messaging';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { messagingId, playerActor } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/conversations/{id}/read — the caller has read everything up
 * to now. Monotonic: a late answer from a second tab never moves it back.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const r = await markConversationRead(playerActor(ctx), messagingId(id, 'id'));
  return ok({ readAt: r.readAt.toISOString() });
}

export const POST = defineV1Route(handler);
