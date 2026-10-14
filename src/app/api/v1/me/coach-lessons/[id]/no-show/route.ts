import { type NextRequest } from 'next/server';

import { markMyLessonNoShow } from '@/app-layer/usecases/coach-lessons';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/coach-lessons/{id}/no-show
 *
 * The coach records that the player did not come to one of their own lessons
 * (#549; owner decision 11). It is the club's no-show: it counts there as one
 * the desk marks, the block on online booking included.
 *
 * 404 LESSON_NOT_FOUND for a lesson that is not the caller's; 409
 * NO_SHOW_REFUSED with `details.reason` when it cannot be marked: `NOT_STARTED`
 * (the lesson has not begun), `ALREADY_NO_SHOW`, `NOT_ATTENDABLE` (cancelled),
 * `REVIEWED` (the player has reviewed it), `ACCOUNT_DELETED`.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  return ok(await markMyLessonNoShow({ userId: ctx.userId, lessonId: id }));
}

export const POST = defineV1Route(handler);
