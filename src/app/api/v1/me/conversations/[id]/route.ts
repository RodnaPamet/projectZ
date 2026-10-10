import { type NextRequest } from 'next/server';

import { getConversation } from '@/app-layer/usecases/messaging';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import {
  cursorParam,
  messagingId,
  playerActor,
  toConversationDto,
} from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/conversations/{id} — one conversation (#375): who it is with,
 * where it stands for the caller, whether they may write, and the newest page
 * of messages, oldest first. `?before=` is the page older than
 * `olderCursor`. An open screen asks every 5 seconds; nothing pushes.
 * 404 CONVERSATION_NOT_FOUND for anybody not in it.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const view = await getConversation(playerActor(ctx), messagingId(id, 'id'), {
    before: cursorParam(req, 'before'),
  });
  return ok(toConversationDto(view));
}

export const GET = defineV1Route(handler);
