import { type NextRequest } from 'next/server';

import { deleteMyCoachReview } from '@/app-layer/usecases/coach-reviews';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * DELETE /api/v1/me/coach-reviews/{id} — delete one's own review of a coach
 * (#551), whatever its status. 204. The coach's rating follows at once; a
 * new review of the same coach can then be written, and is checked again.
 *
 * 404 `COACH_REVIEW_NOT_FOUND` for a review that is not the caller's.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  await deleteMyCoachReview(ctx.userId, id);
  return new Response(null, { status: 204 });
}

export const DELETE = defineV1Route(handler);
