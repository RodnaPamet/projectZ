import { type NextRequest } from 'next/server';

import { sendMessageBodySchema } from '@/app-layer/schemas/messaging';
import { sendMessage } from '@/app-layer/usecases/messaging';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { idempotencyKey, messagingId, playerActor } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/conversations/{id}/messages — say something (#375).
 *
 * `Idempotency-Key` makes a retry safe: the same key answers the first
 * message (`replayed: true`, 200) instead of saying it twice. 201 for a new
 * one. The per-sender limit is the use case's (30 a minute), not the route's,
 * so that it is one budget per person whatever their IP.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const actor = playerActor(ctx);
  const key = idempotencyKey(req);
  const body = await parseJsonBody(req, sendMessageBodySchema, 'message');
  const sent = await sendMessage(actor, messagingId(id, 'id'), body.body, key);
  return ok(
    { id: sent.id, createdAt: sent.createdAt.toISOString(), replayed: sent.replayed },
    { status: sent.replayed ? 200 : 201 },
  );
}

export const POST = defineV1Route(handler);
