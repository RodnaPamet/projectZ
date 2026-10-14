import { type NextRequest } from 'next/server';

import { approvedCoachId, listCoachReviews } from '@/app-layer/usecases/coach-reviews';
import { toCoachReviewsPage } from '@/app/api/v1/_lib/coach-dto';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

const CURSOR = /^[a-z0-9]{8,64}$/;

/**
 * GET /api/v1/coaches/{slug}/reviews?cursor=
 *
 * A coach's published reviews (#551), newest first, ten to a page (`items`,
 * `nextCursor`), and their rating: the weighted average venues use, with the count (decision 27).
 * Public, as the coach's page is. Each review names its author by first name
 * and initial (decision 26), never by account; `mine` is true on the
 * signed-in caller's own, which they may delete and do not report.
 *
 * 404 `NOT_FOUND` for an address that names no approved coach.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cursor = req.nextUrl.searchParams.get('cursor');
  if (cursor !== null && !CURSOR.test(cursor)) {
    throw new ValidationError('Invalid cursor', { field: 'cursor' });
  }
  const coachUserId = await approvedCoachId(slug);
  if (!coachUserId) throw new NotFoundError('Coach not found');
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const page = await listCoachReviews({ coachUserId, viewerId: ctx.userId ?? null, cursor });
  return ok(toCoachReviewsPage(page));
}

export const GET = defineV1Route(handler);
