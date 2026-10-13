import { type NextRequest } from 'next/server';

import { withdrawCoachProfile } from '@/app-layer/usecases/coach-profile';
import { asUser } from '@/app/api/v1/_lib/bind';
import { toMyCoachProfile } from '@/app/api/v1/_lib/coach-dto';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/coach-profile/withdraw
 *
 * Take back a coach profile that is waiting for a decision, to change it
 * (#545). No body. It becomes a draft again and leaves the owner's queue; the
 * text, the sports and the certificate are kept.
 *
 * 409 `COACH_PROFILE_NOT_SUBMITTED` when it is not waiting.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const userId = ctx.userId;
  return ok(toMyCoachProfile(await asUser(ctx, (db) => withdrawCoachProfile(db, userId))));
}

export const POST = defineV1Route(handler);
