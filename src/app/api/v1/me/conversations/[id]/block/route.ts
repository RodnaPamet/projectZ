import { type NextRequest } from 'next/server';

import { blockConversation, unblockConversation } from '@/app-layer/usecases/messaging';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { messagingId, playerActor } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/conversations/{id}/block — no new messages either way. In a
 * conversation with a player it blocks the PERSON, everywhere: they no longer
 * see the conversation or find the caller. In a club conversation it blocks
 * that conversation, until the caller lifts it. Idempotent.
 */
async function postHandler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  return ok(await blockConversation(playerActor(ctx), messagingId(id, 'id')));
}

/** DELETE /api/v1/me/conversations/{id}/block — lift the caller's block. */
async function deleteHandler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  return ok(await unblockConversation(playerActor(ctx), messagingId(id, 'id')));
}

export const POST = defineV1Route(postHandler);
export const DELETE = defineV1Route(deleteHandler);
