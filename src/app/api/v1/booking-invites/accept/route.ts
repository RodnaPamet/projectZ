import { type NextRequest } from 'next/server';

import { bookingInviteTokenBodySchema } from '@/app-layer/schemas/booking-players';
import { acceptBookingInvite } from '@/app-layer/usecases/booking-players';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';
import { INVITE_REDEEM_LIMIT } from '@/lib/security/rate-limit';

/**
 * POST /api/v1/booking-invites/accept — join the booking behind a link (#358).
 * Body `{ token }`. Signed in.
 *
 * Adds the CALLER and nobody else, and only while the court has room. 200
 * `{ bookingId, joined }`; `joined: false` when the caller was already on it
 * (the booker opening their own link included), so a second tap is harmless.
 *
 * Refusals: 404 BOOKING_INVITE_NOT_USABLE (one answer for every dead token),
 * 409 BOOKING_FULL, 403 PLAYER_ACCOUNT_REQUIRED (a club or coach account), 403
 * ACCOUNT_KIND_REQUIRED (choose player or coach first, #360).
 *
 * Rate-limited per IP at INVITE_REDEEM_LIMIT (10 a minute), stricter than the
 * default for writes; the token is in the body for the reason the preview
 * route gives.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const { token } = await parseJsonBody(req, bookingInviteTokenBodySchema, 'invite');
  return ok(await acceptBookingInvite({ userId: ctx.userId, token }));
}

export const POST = defineV1Route(handler, {
  rateLimit: { config: INVITE_REDEEM_LIMIT, scope: 'booking-invite' },
});
