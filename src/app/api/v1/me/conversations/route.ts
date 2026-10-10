import { type NextRequest } from 'next/server';

import { openConversationBodySchema } from '@/app-layer/schemas/messaging';
import {
  listConversations,
  openClubConversation,
  openCoPlayerConversation,
  openPlayerConversation,
} from '@/app-layer/usecases/messaging';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok, page } from '@/app/api/v1/_lib/envelope';
import { cursorParam, playerActor, toSummaryDto } from '@/app/api/v1/_lib/messaging';
import { ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/conversations — the caller's inbox (#375), most recently
 * active first, each with its unread count. `?tab=requests` is «Заявки»:
 * requests TO the caller from people they have never played with. Paginated
 * by an opaque `cursor`.
 */
async function getHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const actor = playerActor(ctx);
  const tab = req.nextUrl.searchParams.get('tab') ?? 'conversations';
  if (tab !== 'conversations' && tab !== 'requests') {
    throw new ValidationError('`tab` is conversations or requests', { field: 'tab' });
  }
  const result = await listConversations(actor, { tab, cursor: cursorParam(req, 'cursor') });
  return page(result.items.map(toSummaryDto), result.nextCursor);
}

/**
 * POST /api/v1/me/conversations — open the conversation with a player
 * (`{ playerId }`), a club (`{ club: slug }`), or a player on one of the
 * caller's bookings (`{ bookingId, participantId }`, null for the booker): the
 * one there is, or a new
 * one. Idempotent: 200 with `created: false` for an existing one, 201 when
 * this call made it. A player who cannot be written to is 404 PLAYER_NOT_FOUND,
 * indistinguishable from one who does not exist.
 */
async function postHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const actor = playerActor(ctx);
  const body = await parseJsonBody(req, openConversationBodySchema, 'conversation');
  const result =
    'playerId' in body
      ? await openPlayerConversation(actor, body.playerId)
      : 'club' in body
        ? await openClubConversation(actor, body.club)
        : await openCoPlayerConversation(actor, body.bookingId, body.participantId);
  return ok(result, { status: result.created ? 201 : 200 });
}

export const GET = defineV1Route(getHandler);
export const POST = defineV1Route(postHandler);
