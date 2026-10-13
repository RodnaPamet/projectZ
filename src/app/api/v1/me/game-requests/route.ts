import { type NextRequest } from 'next/server';

import { listMyGameRequests } from '@/app-layer/usecases/open-play';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toMyGameRequestDto } from '@/app/api/v1/_lib/open-play-dto';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/game-requests — «Моите заявки» (#376): the caller's requests
 * for games still to come or started in the last week, newest first, each in
 * its state as of now (a waiting one past the club's cutoff reads LAPSED).
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const rows = await listMyGameRequests({ userId: ctx.userId });
  return ok(rows.map(toMyGameRequestDto));
}

export const GET = defineV1Route(handler);
