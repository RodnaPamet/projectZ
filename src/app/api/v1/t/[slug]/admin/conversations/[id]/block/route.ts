import { type NextRequest } from 'next/server';

import { blockConversation, unblockConversation } from '@/app-layer/usecases/messaging';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { clubActor, messagingId } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/t/{slug}/admin/conversations/{id}/block — the club stops this
 * conversation: no new messages either way until the club lifts it.
 * Idempotent.
 */
async function postHandler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  return ok(await blockConversation(clubActor(ctx), messagingId(id, 'id')));
}

/**
 * DELETE …/block — lift the club's block. 403 BLOCKED_BY_OTHER_SIDE when it
 * was the player who blocked.
 */
async function deleteHandler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  return ok(await unblockConversation(clubActor(ctx), messagingId(id, 'id')));
}

export const POST = defineV1Route(postHandler);
export const DELETE = defineV1Route(deleteHandler);
