import { type NextRequest } from 'next/server';

import { reportResultBodySchema } from '@/app-layer/schemas/results';
import { enterClubResult, readClubBookingResult } from '@/app-layer/usecases/match-results';
import { notifyResultDecided } from '@/app-layer/usecases/result-notifications';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/t/{slug}/admin/bookings/{id}/result (#575): one booking's result
 * for the desk, whether the club may enter it, how its score is entered, and
 * the players to pick sides from. Needs `bookings.view_all`; 404 for another
 * club's booking.
 */
async function getHandler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const state = await readClubBookingResult(ctx.tenantId, id);
  if (!state) throw new NotFoundError('Booking not found');
  return ok(state);
}

/**
 * POST /api/v1/t/{slug}/admin/bookings/{id}/result (#575): the club enters a
 * booking's result itself. It is final and counts at once (the default taken
 * in round 4 of #378); the players are told. Needs `bookings.view_all`.
 *
 * 400 INVALID_SIDES, INVALID_SCORE; 404 for another club's booking; 409
 * RESULT_NOT_REPORTABLE, RESULT_ALREADY_REPORTED.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const body = await parseJsonBody(req, reportResultBodySchema, 'result');
  const { reportId } = await enterClubResult(
    { userId: ctx.userId, tenantId: ctx.tenantId },
    id,
    body,
  );
  await notifyResultDecided({ tenantId: ctx.tenantId, reportId });
  return ok({ reportId, status: 'DECIDED' }, { status: 201 });
}

export const GET = defineV1Route(getHandler);
export const POST = defineV1Route(handler);
