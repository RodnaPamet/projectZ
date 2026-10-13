import { type NextRequest } from 'next/server';

import { removeTimeOff } from '@/app-layer/usecases/coach-time-off';
import { asUser } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * DELETE /api/v1/me/coach-time-off/{id}
 *
 * Take a stretch of days off back (#546). The caller's own only: another
 * coach's id, or none, is 404 `COACH_TIME_OFF_NOT_FOUND`. Answers `{ items }`
 * with what is left.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const userId = ctx.userId;
  return ok({ items: await asUser(ctx, (db) => removeTimeOff(db, userId, id)) });
}

export const DELETE = defineV1Route(handler);
