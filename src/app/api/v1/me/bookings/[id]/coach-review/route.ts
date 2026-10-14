import { type NextRequest } from 'next/server';

import { coachReviewBodySchema } from '@/app-layer/schemas/coach-reviews';
import { createCoachReview } from '@/app-layer/usecases/coach-reviews';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { toCreatedCoachReview } from '@/app/api/v1/_lib/coach-dto';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/bookings/{id}/coach-review — review the coach of a lesson
 * the caller was on (#551): `{ rating, body? }`.
 *
 * The coach is the lesson's; it cannot be named. The lesson must be over and
 * COMPLETED (a no-show is not), and the caller its booker or a player on it
 * (decision 25). One review per coach per player, at any club (decision 24):
 * a second is 409 `COACH_ALREADY_REVIEWED`.
 *
 * The text is checked before it is stored, as a venue review's is: `status`
 * is PUBLISHED when it passed, PENDING_REVIEW while a moderator looks, and
 * REJECTED when the classifier refused it (a moderator still sees it). Stars
 * with no text are published at once.
 *
 * 403 `NO_LESSON_TO_REVIEW` for anything else, somebody else's booking included.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const body = await parseJsonBody(req, coachReviewBodySchema, 'review');
  const review = await createCoachReview({
    authorUserId: ctx.userId,
    bookingId: id,
    rating: body.rating,
    body: body.body ?? null,
  });
  return ok(toCreatedCoachReview(review), { status: 201 });
}

export const POST = defineV1Route(handler);
