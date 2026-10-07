import { type NextRequest } from 'next/server';

import { resolvePlayerTenant } from '@/app-layer/usecases/club-membership';
import { createReview, REVIEW_MAX_LENGTH } from '@/app-layer/usecases/reviews';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toReview } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError, UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * Review the venue a booking was at.
 *
 * ═══ WHY IT HANGS OFF THE BOOKING ═══
 *
 * The booking IS the proof of visit, so it is the thing addressed: the venue is
 * derived from it and there is no `venueId` in the body to point anywhere else.
 * Same shape as `/cancel` and `/checkout` — an action on one of your bookings.
 *
 * ═══ WHAT THE PERMISSION DOES AND DOES NOT PROVE ═══
 *
 * ROUTE_PERMISSIONS asks for `bookings.create`, which every member holds —
 * reviewing is something any player does. It establishes membership and nothing
 * else. Ownership, completion and "not already reviewed" are row-level facts,
 * checked by `createReview` against the row, under a lock.
 *
 * ═══ THE TENANT COMES FROM THE DATABASE ═══
 *
 * `resolvePlayerTenant`, as the bookings route does. `ctx.tenantId` is resolved
 * from the database too since #250, but this also refuses a club that is no
 * longer ACTIVE. It never joins — a review is left by someone who already
 * booked, and booking made them a member. A suspended member gets the same 404
 * as an unknown club.
 *
 * ═══ MODERATION HAPPENS HERE, SYNCHRONOUSLY ═══
 *
 * Text is classified before the row is written, so a request carrying text can
 * take as long as the classifier's ten-second timeout. The response says what
 * happened: PUBLISHED, PENDING_REVIEW (a human will look), or REJECTED. None of
 * those is an error — a held review was still received.
 */

interface CreateBody {
  rating?: unknown;
  body?: unknown;
}

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });

  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const payload = (await req.json().catch(() => {
    throw new ValidationError('Body must be JSON');
  })) as CreateBody | null;

  // The range is the use case's rule (InvalidRatingError → 400 INVALID_RATING).
  // Only the TYPE is checked here, so "5" is refused rather than coerced: a
  // client sending a string has a bug, and quietly accepting it hides it.
  const rating = payload?.rating;
  if (typeof rating !== 'number') {
    throw new ValidationError('`rating` must be a whole number from 1 to 5', { field: 'rating' });
  }

  const text = payload?.body;
  if (text !== undefined && text !== null && typeof text !== 'string') {
    throw new ValidationError('`body` must be a string', { field: 'body' });
  }
  // Refused, not truncated. The use case trims to the limit as a backstop, but
  // a client that sent more must be told, not have its text cut off silently.
  if (typeof text === 'string' && text.length > REVIEW_MAX_LENGTH) {
    throw new ValidationError(`\`body\` may be at most ${REVIEW_MAX_LENGTH} characters`, {
      field: 'body',
    });
  }

  const standing = await resolvePlayerTenant(ctx.userId, slug, { createIfAbsent: false });
  if (!standing) throw new NotFoundError('Booking not found');

  const tenantCtx = { ...ctx, tenantId: standing.tenantId };
  const review = await createReview((fn) => inTenant(tenantCtx, fn), {
    tenantId: standing.tenantId,
    bookingId: id,
    authorUserId: ctx.userId,
    rating,
    body: text ?? null,
  });

  return ok(toReview(review), { status: 201 });
}

export const POST = defineV1Route(handler);
