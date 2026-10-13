import { type NextRequest } from 'next/server';

import { addTimeOff, listTimeOff } from '@/app-layer/usecases/coach-time-off';
import { asUser } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET  /api/v1/me/coach-time-off   the caller's days off that are not over
 * POST /api/v1/me/coach-time-off   add a stretch: { startDate, endDate?, note? }
 *
 * A coach's days off (#546; owner decision 14): calendar dates, both ends
 * included, on which the coach teaches at no venue. For COACH accounts.
 *
 * `startDate` and `endDate` are `YYYY-MM-DD`; without `endDate` it is one
 * day. A stretch may already have started but not have ended, starts at most
 * a year ahead, and is at most 92 days long. `note` is the coach's own, up to
 * 200 characters, and is shown to nobody else. 400 `VALIDATION_ERROR` with
 * `details.field` and `details.reason` otherwise; 409 `COACH_TIME_OFF_LIMIT`
 * past 50 stretches.
 *
 * Both answer `{ items }`, soonest first.
 */
async function getHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const userId = ctx.userId;
  return ok({ items: await asUser(ctx, (db) => listTimeOff(db, userId)) });
}

async function postHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const userId = ctx.userId;
  const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const items = await asUser(ctx, (db) =>
    addTimeOff(db, userId, {
      startDate: body.startDate,
      endDate: body.endDate,
      note: body.note,
    }),
  );
  return ok({ items }, { status: 201 });
}

export const GET = defineV1Route(getHandler);
export const POST = defineV1Route(postHandler);
