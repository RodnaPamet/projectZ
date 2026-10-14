import { type NextRequest } from 'next/server';

import { reportBodySchema } from '@/app-layer/schemas/messaging';
import { reportCoachReview } from '@/app-layer/usecases/coach-reviews';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/coach-reviews/{id}/report — report a review on a coach's page
 * to the platform's moderators (#551): `{ reason, details? }`, as a message is
 * reported. One case per review however many report it; nobody is told who.
 * The coach can report a review of themselves; they cannot remove one.
 *
 * 404 `COACH_REVIEW_NOT_FOUND` for one that is not published; 400
 * `REPORT_OWN_REVIEW` for one's own (delete it instead).
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const body = await parseJsonBody(req, reportBodySchema, 'report');
  return ok(await reportCoachReview({ reporterUserId: ctx.userId, reviewId: id, ...body }), {
    status: 201,
  });
}

export const POST = defineV1Route(handler);
