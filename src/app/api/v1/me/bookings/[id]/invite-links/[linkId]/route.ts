import { type NextRequest } from 'next/server';

import { revokeBookingInviteLinks } from '@/app-layer/usecases/booking-players';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * DELETE /api/v1/me/bookings/{id}/invite-links/{linkId} — stop one link (the
 * `id` from creating it). 200 `{ revoked }`: 1, or 0 if it was already
 * stopped. 404 PLAYER_NOT_FOUND for a link id not on this booking. Audited.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; linkId: string }> },
) {
  const { id, linkId } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  return ok(await revokeBookingInviteLinks({ userId: ctx.userId, bookingId: id, linkId }));
}

export const DELETE = defineV1Route(handler);
