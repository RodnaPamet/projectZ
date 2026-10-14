import { type NextRequest } from 'next/server';

import { answerResult } from '@/app-layer/usecases/match-results';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/results/{id}/confirm (#575): a player on the other side
 * confirms a reported result, and it counts toward ratings.
 *
 * 403 RESULT_NOT_YOURS_TO_ANSWER (the caller's own side reported it); 404 for
 * a result the caller did not play; 409 RESULT_NOT_AWAITING (already
 * answered, confirmed by the 48 hours, or with the club).
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const { status } = await answerResult(ctx.userId, id, { action: 'confirm' });
  return ok({ status });
}

export const POST = defineV1Route(handler);
