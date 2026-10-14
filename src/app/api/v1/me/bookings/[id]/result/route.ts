import { type NextRequest } from 'next/server';

import { reportResultBodySchema } from '@/app-layer/schemas/results';
import { readBookingResult, reportResult } from '@/app-layer/usecases/match-results';
import { notifyResultReported } from '@/app-layer/usecases/result-notifications';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError, UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/bookings/{id}/result (#575): where the booking's result
 * stands for the caller: the result, whether they may report it or answer it,
 * how its score is entered, and the players to pick sides from. 404 for a
 * booking that is not the caller's.
 */
async function getHandler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const state = await readBookingResult(ctx.userId, id);
  if (!state) throw new NotFoundError('Booking not found');
  return ok(state);
}

/**
 * POST /api/v1/me/bookings/{id}/result (#575): a player on a completed booking
 * reports its result, within 7 days of its end: `{ sides: [[ids], [ids]],
 * score: [[6,4],[6,3]] }`. The other side is told and has 48 hours.
 *
 * 400 INVALID_SIDES, INVALID_SCORE; 404 for a booking that is not the
 * caller's; 409 RESULT_NOT_REPORTABLE (not completed, the 7 days passed, a
 * sport with no score), RESULT_ALREADY_REPORTED.
 */
async function postHandler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const body = await parseJsonBody(req, reportResultBodySchema, 'result');
  const { reportId, tenantId } = await reportResult(ctx.userId, id, body);
  await notifyResultReported({ tenantId, reportId });
  return ok(await readBookingResult(ctx.userId, id), { status: 201 });
}

export const GET = defineV1Route(getHandler);
export const POST = defineV1Route(postHandler);
