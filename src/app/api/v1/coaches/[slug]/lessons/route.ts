import { type NextRequest } from 'next/server';

import { bookLessonBodySchema } from '@/app-layer/schemas/coach';
import { notifyBookingConfirmed } from '@/app-layer/usecases/booking-notifications';
import { bookLesson } from '@/app-layer/usecases/coach-lessons';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { toBookedLesson } from '@/app/api/v1/_lib/coach-dto';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toBooking } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';
import { countUsage } from '@/lib/usage/record';

/**
 * POST /api/v1/coaches/{slug}/lessons
 *
 * Book a lesson (#548): a court booking with the coach on it, taken together
 * or not at all. The body names the coach's link, a start and a length; the
 * court is chosen by the server (the cheapest one free then) and so is every
 * price. Answers with the booking, as `POST /t/{slug}/bookings` does, plus a
 * `lesson` block: the coach, the coach's fee, the court's price and the total.
 * Both parts are paid at the club.
 *
 * An `Idempotency-Key` header is required, as for a court booking: a retry
 * with the same key returns the lesson that was booked (200), not a second.
 *
 * Refusals a client should tell apart:
 *   409 COACH_TAKEN              the coach was booked for that time first
 *   409 SLOT_TAKEN               no court is left at that time
 *   409 LESSON_TIME_NOT_OFFERED  the coach does not teach then
 *   409 LESSON_PRICE_CHANGED     it would cost more than `expectedTotalCents`
 *   400 LESSON_LENGTH_NOT_OFFERED, 404 COACH_NOT_BOOKABLE, 400 OWN_LESSON
 * and every refusal a court booking has: 403 PHONE_REQUIRED,
 * PLAYER_ACCOUNT_REQUIRED and NO_SHOW_BLOCKED, 409 for the cap on upcoming
 * online bookings.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const idempotencyKey = req.headers.get('idempotency-key');
  if (!idempotencyKey || idempotencyKey.trim() === '') {
    throw new ValidationError('An `Idempotency-Key` header is required', {
      field: 'Idempotency-Key',
    });
  }
  const body = await parseJsonBody(req, bookLessonBodySchema, 'lesson');

  const booked = await bookLesson({
    userId: ctx.userId,
    coachSlug: slug,
    linkId: body.linkId,
    startTs: new Date(body.startTs),
    minutes: body.minutes,
    sport: body.sport,
    idempotencyKey,
    notes: body.notes ? body.notes : null,
    expectedTotalCents: body.expectedTotalCents,
  });

  if (!booked.replay) {
    await notifyBookingConfirmed({ tenantId: booked.tenantId, bookingId: booked.bookingId });
    countUsage(
      'BOOKING_CREATED',
      { venueId: booked.venueId },
      { userAgent: req.headers.get('user-agent') },
    );
  }

  return ok(
    { ...toBooking(booked.booking), lesson: toBookedLesson(booked.lesson) },
    { status: booked.replay ? 200 : 201 },
  );
}

export const POST = defineV1Route(handler);
