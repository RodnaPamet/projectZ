import { type NextRequest } from 'next/server';

import { bookingWhenSchema } from '@/app-layer/schemas/booking';
import { listMyLessons } from '@/app-layer/usecases/coach-lessons';
import { toMyLesson } from '@/app/api/v1/_lib/coach-dto';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { page } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/coach-lessons?when=upcoming|past&limit=&cursor=
 *
 * The lessons the caller teaches, at every club (#548): `upcoming` (the
 * default) is every lesson still on and not yet over, soonest first; `past`
 * is every other one (over, or cancelled), newest first. Each carries where
 * and when, the court, who booked it, and the coach's own fee.
 *
 * A COACH account only: anybody else is 403 COACH_ACCOUNT_REQUIRED.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const sp = req.nextUrl.searchParams;
  const when = bookingWhenSchema.safeParse(sp.get('when') ?? undefined);
  if (!when.success) {
    throw new ValidationError('`when` must be "upcoming" or "past"', { field: 'when' });
  }

  const { items, nextCursor } = await listMyLessons({
    userId: ctx.userId,
    when: when.data ?? 'upcoming',
    cursor: sp.get('cursor') || null,
    limit: sp.has('limit') ? Number(sp.get('limit')) : undefined,
  });
  return page(items.map(toMyLesson), nextCursor);
}

export const GET = defineV1Route(handler);
