import { type NextRequest } from 'next/server';

import { openClubConversationBodySchema } from '@/app-layer/schemas/messaging';
import { listConversations, openClubConversationWithPlayer } from '@/app-layer/usecases/messaging';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok, page } from '@/app/api/v1/_lib/envelope';
import { clubActor, cursorParam, toSummaryDto } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/t/{slug}/admin/conversations — the club's shared inbox (#375):
 * every conversation players have with the club, most recently active first,
 * each with the caller's own unread count. OWNER, MANAGER and STAFF
 * (`messages.club`).
 */
async function getHandler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  const result = await listConversations(clubActor(ctx), { cursor: cursorParam(req, 'cursor') });
  return page(result.items.map(toSummaryDto), result.nextCursor);
}

/**
 * POST /api/v1/t/{slug}/admin/conversations — open the club's conversation
 * with a player on its Играчи list (`{ playerId }`): the one there is, or a
 * new one. 403 NOT_A_CLUB_PLAYER for anybody else.
 */
async function postHandler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  const actor = clubActor(ctx);
  const body = await parseJsonBody(req, openClubConversationBodySchema, 'conversation');
  const result = await openClubConversationWithPlayer(actor, body.playerId);
  return ok(result, { status: result.created ? 201 : 200 });
}

export const GET = defineV1Route(getHandler);
export const POST = defineV1Route(postHandler);
