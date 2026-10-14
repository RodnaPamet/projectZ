import { type NextRequest } from 'next/server';

import { cancelMyLesson } from '@/app-layer/usecases/coach-lessons';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/coach-lessons/{id}/cancel
 *
 * The coach cancels one of their own lessons (#549; owner decision 8): until
 * it starts, with no cutoff. The court is released with it, and the player
 * and anybody they added are told, by bell and email. An optional `reason`
 * is kept on the cancellation's record.
 *
 * 404 LESSON_NOT_FOUND for a lesson that is not the caller's; 409
 * LESSON_STARTED once it has started; 409 BOOKING_NOT_CANCELLABLE when it was
 * already cancelled.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const reason = await req
    .json()
    .then((b: { reason?: unknown }) =>
      typeof b?.reason === 'string' && b.reason.trim() !== ''
        ? b.reason.trim().slice(0, 500)
        : undefined,
    )
    .catch(() => undefined);

  return ok(await cancelMyLesson({ userId: ctx.userId, lessonId: id, reason }));
}

export const POST = defineV1Route(handler);
