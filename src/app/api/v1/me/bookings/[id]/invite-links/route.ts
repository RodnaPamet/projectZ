import { type NextRequest } from 'next/server';

import {
  createBookingInviteLink,
  revokeBookingInviteLinks,
} from '@/app-layer/usecases/booking-players';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { rfc3339, type BookingInviteLinkDto } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { env } from '@/env';
import { bookingInviteUrl } from '@/lib/booking/invite-path';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/me/bookings/{id}/invite-links — a link for the booker to share
 * (#358). 201 `{ id, token, url, expiresAt }`.
 *
 * ═══ THE TOKEN IS IN THIS ANSWER AND NOWHERE ELSE ═══
 *
 * Only its HMAC is stored, and it is never logged or audited, so it cannot be
 * shown again: a client that lost it makes another (old ones keep working
 * until the game starts or they are stopped; at most 10 live per booking).
 * `Cache-Control: no-store`, so no cache between here and the client keeps it.
 *
 * The link adds whoever opens it, signed in, while the court has room, until
 * `expiresAt` (the booking's start). Booker only: 403 BOOKER_ONLY for an added
 * player; 409 BOOKING_PLAYERS_CLOSED once it started or was cancelled.
 */
async function postHandler(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const link = await createBookingInviteLink({ userId: ctx.userId, bookingId: id });
  const dto: BookingInviteLinkDto = {
    id: link.id,
    token: link.token,
    url: bookingInviteUrl(env.APP_URL ?? env.NEXTAUTH_URL ?? '', link.token),
    expiresAt: rfc3339(link.expiresAt),
  };
  return ok(dto, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * DELETE /api/v1/me/bookings/{id}/invite-links — stop every live link on the
 * booking. 200 `{ revoked }`, how many this stopped (0 is not an error).
 * Audited (BOOKING_INVITE_LINK_REVOKED). Players already added stay.
 */
async function deleteHandler(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  return ok(await revokeBookingInviteLinks({ userId: ctx.userId, bookingId: id }));
}

export const POST = defineV1Route(postHandler);
export const DELETE = defineV1Route(deleteHandler);
