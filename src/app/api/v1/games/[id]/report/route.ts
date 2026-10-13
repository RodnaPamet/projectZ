import { type NextRequest } from 'next/server';

import { reportBodySchema } from '@/app-layer/schemas/messaging';
import { reportGameNote } from '@/app-layer/usecases/open-play-report';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/games/{id}/report (#526): report the public note on a game to
 * the platform's moderators. The body is a message report's: a `reason`, and
 * `details` in the person's own words if they want.
 *
 * One open case per game however many people report it. The booker is not
 * told, and the moderator never learns who reported. Reporting the same note
 * again is not an error.
 *
 * 400 REPORT_OWN_NOTE; 401 UNAUTHORIZED; 403 PLAYER_ACCOUNT_REQUIRED; 404
 * GAME_NOT_FOUND, GAME_NOTE_NOT_FOUND (the game has no note); 429
 * RATE_LIMITED (10 a day per account).
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const report = await parseJsonBody(req, reportBodySchema, 'report');
  // 201, as a message's report: a report was filed.
  return ok(await reportGameNote({ userId: ctx.userId, gameId: id, report }), { status: 201 });
}

export const POST = defineV1Route(handler);
