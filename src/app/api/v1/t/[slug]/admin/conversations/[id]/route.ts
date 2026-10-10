import { type NextRequest } from 'next/server';

import { getConversation } from '@/app-layer/usecases/messaging';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import {
  clubActor,
  cursorParam,
  messagingId,
  toConversationDto,
} from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/t/{slug}/admin/conversations/{id} — one of the club's
 * conversations, as the club's staff read it: each reply names the colleague
 * who wrote it. 404 for a conversation of another club.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  const view = await getConversation(clubActor(ctx), messagingId(id, 'id'), {
    before: cursorParam(req, 'before'),
  });
  return ok(toConversationDto(view));
}

export const GET = defineV1Route(handler);
