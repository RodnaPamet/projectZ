import { type NextRequest } from 'next/server';

import { bookingInviteTokenBodySchema } from '@/app-layer/schemas/booking-players';
import {
  BookingInviteNotUsableError,
  previewBookingInvite,
} from '@/app-layer/usecases/booking-players';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toBookingInvitePreviewDto } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { INVITE_REDEEM_LIMIT } from '@/lib/security/rate-limit';

/**
 * POST /api/v1/booking-invites/preview — what an invite link is for, before
 * anyone signs in (#358). Body `{ token }`. PUBLIC: the person holding the
 * link usually has no session yet, and an offer shown before the sign-in wall
 * is what makes the link credible.
 *
 * ═══ NOTHING PRIVATE ═══
 *
 * The venue's name and city, the court and sport, the time, the booker's FIRST
 * name, and how many places are left. Not the booker's surname, email or
 * phone, not the other players, not the price, not the booking id.
 *
 * ═══ WHY POST, WITH THE TOKEN IN THE BODY ═══
 *
 * A path is written to the request log, the trace (`http.route`) and the
 * metrics label of every request; a body is not. A GET with the token in the
 * path would put a working link into all three. POST also puts it under the
 * wrapper's rate limiter (INVITE_REDEEM_LIMIT, 10 a minute per IP), which
 * never applies to a GET.
 *
 * Every unusable token (malformed, unknown, revoked, expired, or its booking
 * cancelled or started) is the same 404 BOOKING_INVITE_NOT_USABLE.
 */
async function handler(req: NextRequest) {
  const { token } = await parseJsonBody(req, bookingInviteTokenBodySchema, 'invite');
  const preview = await previewBookingInvite(token);
  if (!preview) throw new BookingInviteNotUsableError();
  return ok(toBookingInvitePreviewDto(preview), { headers: { 'Cache-Control': 'no-store' } });
}

export const POST = defineV1Route(handler, {
  rateLimit: { config: INVITE_REDEEM_LIMIT, scope: 'booking-invite' },
});
