import { type NextRequest } from 'next/server';

import { withdrawMyRequest } from '@/app-layer/usecases/open-play';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { noContent } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * DELETE /api/v1/me/game-requests/{id} — take one's request back (#376): a
 * waiting one is withdrawn; an accepted one means leaving the game, until the
 * club's cutoff (409 OPEN_PLAY_CUTOFF_PASSED after it). 204. 404 for a request
 * that is not the caller's; 409 REQUEST_NOT_PENDING for one already answered.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  await withdrawMyRequest({ userId: ctx.userId, requestId: id });
  return noContent();
}

export const DELETE = defineV1Route(handler);
