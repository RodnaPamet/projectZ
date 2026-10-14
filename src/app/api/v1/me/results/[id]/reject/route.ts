import { type NextRequest } from 'next/server';

import { rejectResultBodySchema } from '@/app-layer/schemas/results';
import { answerResult } from '@/app-layer/usecases/match-results';
import { notifyResultDisputed } from '@/app-layer/usecases/result-notifications';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/results/{id}/reject (#575): a player on the other side
 * rejects a reported result, with a note for the club if they want. The club
 * decides (decision 34) and its desk is told.
 *
 * Errors as `/confirm`.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const body = await parseJsonBody(req, rejectResultBodySchema, 'answer');
  const { status, tenantId } = await answerResult(ctx.userId, id, {
    action: 'reject',
    note: body.note ?? null,
  });
  await notifyResultDisputed({ tenantId, reportId: id });
  return ok({ status });
}

export const POST = defineV1Route(handler);
